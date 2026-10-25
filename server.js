
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;

const VK_SERVICE_KEY = process.env.VK_SERVICE_KEY;
const VK_MARKET_TOKEN = process.env.VK_MARKET_TOKEN;
const VK_GROUP_TOKEN = process.env.VK_GROUP_TOKEN;
const VK_GROUP_DOMAIN = process.env.VK_GROUP_DOMAIN || "shashlychok50";
const VK_MENU_MARKER = (process.env.VK_MENU_MARKER || "#менюшашлычок").toLowerCase();
let lastVkMenuSync = 0;
let vkMenuSyncInProgress = false;

function normalizeMenuText(value) {
  return String(value || "")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function parseVkMenu(text) {
  const categories = [];
  let current = null;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.toLowerCase().includes(VK_MENU_MARKER)) continue;

    const bracketCategory = line.match(/^\[([^\]]+)\]$/);
    const colonCategory = line.match(/^([^:=|—–-]{2,50}):$/);
    if (bracketCategory || colonCategory) {
      const name = (bracketCategory || colonCategory)[1].trim();
      if (name) {
        current = { id: normalizeMenuText(name), name, items: [] };
        categories.push(current);
      }
      continue;
    }

    const itemMatch = line.match(/^(.+?)\s*(?:—|–|-|\|)\s*(\d+(?:[.,]\d{1,2})?)\s*(?:₽|руб(?:лей|ля|ль)?\.?|р\.?)?(?:\s*(?:\/|\()\s*(\d{2,4})\s*(?:г|гр|грамм(?:а|ов)?)(?:\))?)?$/i);
    if (!itemMatch) continue;

    const name = itemMatch[1].trim().replace(/^[•*\-]+\s*/, "");
    const price = Math.round(Number(itemMatch[2].replace(",", ".")));
    const weight = Number(itemMatch[3] || 300);
    if (!name || !Number.isFinite(price) || price <= 0) continue;

    if (!current) {
      current = { id: "menu", name: "Меню", items: [] };
      categories.push(current);
    }
    current.items.push({ name, price, weight });
  }

  return categories.filter(category => category.items.length > 0);
}

async function syncMenuFromVk() {
  if (!VK_SERVICE_KEY || vkMenuSyncInProgress || Date.now() - lastVkMenuSync < 60000) return;
  vkMenuSyncInProgress = true;
  try {
    async function vkCall(method, values, token = VK_SERVICE_KEY) {
      const params = new URLSearchParams({
        access_token: token,
        v: "5.199",
        ...values
      });
      const response = await fetch("https://api.vk.com/method/" + method + "?" + params.toString());
      const result = await response.json();
      if (!response.ok || result.error) {
        const error = result.error || { error_msg: "HTTP " + response.status };
        console.error("VK API " + method + " failed:", error);
        throw new Error(method + ": " + (error.error_msg || JSON.stringify(error)));
      }
      return result.response;
    }

    // Resolve the community ID from its short address first.
    const groupData = await vkCall("groups.getById", {
      group_ids: VK_GROUP_DOMAIN,
      fields: "description,cover,photo_200"
    });
    const groupInfo = groupData?.groups?.[0] || groupData?.[0];
    if (!groupInfo?.id) throw new Error("VK community not found: " + VK_GROUP_DOMAIN);
    const groupId = String(groupInfo.id);

    let parsed = [];
    let source = "";
    try {
      // The community's Market section is the primary source of menu data.
      const marketParams = {
        owner_id: "-" + groupId,
        count: "200",
        offset: "0",
        extended: "1"
      };
      // market.get is not available with a VK service key. Prefer a dedicated
      // user access token with market permission; try the community token as a
      // compatibility fallback, then the legacy service key.
      const marketTokens = [VK_MARKET_TOKEN, VK_GROUP_TOKEN, VK_SERVICE_KEY]
        .filter(Boolean)
        .filter((token, index, all) => all.indexOf(token) === index);
      let marketData = null;
      let lastMarketError = null;
      for (const token of marketTokens) {
        try {
          marketData = await vkCall("market.get", marketParams, token);
          break;
        } catch (error) {
          lastMarketError = error;
          console.warn("VK market.get attempt failed; trying another configured token.");
        }
      }
      if (!marketData) throw lastMarketError || new Error("No VK market token configured.");
      const marketItems = Array.isArray(marketData?.items) ? marketData.items : [];
      const byCategory = new Map();

      for (const product of marketItems) {
        const name = String(product.title || "").trim();
        if (!name) continue;

        const priceObject = product.price || {};
        const priceText = String(priceObject.text || "");
        let price = 0;
        // Prefer VK's formatted price. Fall back to amount in thousandths of currency.
        const textMatch = priceText.replace(/\u00a0/g, " ").match(/[\d\s]+(?:[.,]\d{1,2})?/);
        if (textMatch) {
          price = Math.round(Number(textMatch[0].replace(/\s/g, "").replace(",", ".")));
        }
        if (!(price > 0) && priceObject.amount != null) {
          const amount = Number(priceObject.amount);
          if (Number.isFinite(amount) && amount > 0) price = Math.round(amount / 1000);
        }
        if (!(price > 0)) {
          console.warn("VK market item skipped because its price could not be read:", name);
          continue;
        }

        const categoryName = String(product.category?.name || "Меню").trim() || "Меню";
        if (!byCategory.has(categoryName)) {
          byCategory.set(categoryName, {
            id: normalizeMenuText(categoryName) || "menu",
            name: categoryName,
            items: []
          });
        }

        const photos = Array.isArray(product.photos) ? product.photos : [];
        const photoCandidates = photos.flatMap(photo => Array.isArray(photo.sizes) ? photo.sizes : []);
        const bestPhoto = photoCandidates.slice().sort((a, b) =>
          (Number(b.width || 0) * Number(b.height || 0)) -
          (Number(a.width || 0) * Number(a.height || 0))
        )[0];
        const photo = bestPhoto?.url || product.thumb_photo || "";

        const description = String(product.description || "").trim();
        const weightMatch = (name + " " + description).match(/(\d{2,4})\s*(?:г|гр|грамм)/i);
        byCategory.get(categoryName).items.push({
          name,
          price,
          weight: Number(weightMatch?.[1] || 300),
          photo,
          description
        });
      }

      parsed = Array.from(byCategory.values()).filter(category => category.items.length);
      if (parsed.length) source = "market";
    } catch (error) {
      console.warn("VK Market sync unavailable; trying marked wall post:", error.message);
    }

    // Backward-compatible fallback for communities that still keep a text menu on the wall.
    if (!parsed.length) {
      const wallData = await vkCall("wall.get", {
        domain: VK_GROUP_DOMAIN,
        count: "50",
        filter: "owner"
      });
      const posts = Array.isArray(wallData?.items) ? wallData.items : [];
      // Accept the legacy marker or a wall post whose heading is "МЕНЮ" / "ТОВАРЫ".
      // VK wall posts do not expose a separate title field, so inspect the first non-empty line.
      const post = posts.find(item => {
        const text = String(item.text || "").trim();
        const normalizedText = normalizeMenuText(text);
        if (normalizedText.includes(normalizeMenuText(VK_MENU_MARKER))) return true;
        const firstLine = text.split(/\\r?\\n/).map(line => line.trim()).find(Boolean) || "";
        const heading = normalizeMenuText(firstLine).replace(/^#/, "");
        return heading === "меню" || heading === "товары" ||
          heading.startsWith("меню") || heading.startsWith("товары");
      });
      if (post) {
        parsed = parseVkMenu(post.text);
        if (parsed.length) {
          const photoUrls = (post.attachments || [])
            .filter(attachment => attachment.type === "photo" && attachment.photo)
            .map(attachment => {
              const sizes = attachment.photo.sizes || [];
              const best = sizes.slice().sort((a, b) =>
                (Number(b.width || 0) * Number(b.height || 0)) -
                (Number(a.width || 0) * Number(a.height || 0))
              )[0];
              return best?.url || attachment.photo.photo_1280 ||
                attachment.photo.photo_807 || attachment.photo.photo_604 || "";
            })
            .filter(Boolean);
          const flatItems = parsed.flatMap(category => category.items);
          if (photoUrls.length === flatItems.length) {
            let photoIndex = 0;
            for (const category of parsed) {
              for (const item of category.items) item.photo = photoUrls[photoIndex++];
            }
          }
          source = "wall";
        }
      }
    }

    const config = readConfig();
    const oldCategories = Array.isArray(config.categories) ? config.categories : [];

    // Do not erase the existing menu if VK returns no products or an API permission error.
    if (parsed.length) {
      const nextCategories = parsed.map(category => {
        const oldCategory = oldCategories.find(c =>
          normalizeMenuText(c.name) === normalizeMenuText(category.name)
        );
        const oldItems = Array.isArray(oldCategory?.items) ? oldCategory.items : [];
        return {
          id: oldCategory?.id || category.id,
          name: category.name,
          items: category.items.map(item => {
            const oldItem = oldItems.find(p =>
              normalizeMenuText(p.name) === normalizeMenuText(item.name)
            );
            return {
              ...(oldItem || {}),
              id: oldItem?.id || normalizeMenuText(item.name),
              name: item.name,
              price: item.price,
              weight: item.weight || oldItem?.weight || 300,
              photo: item.photo || oldItem?.photo || "",
              description: item.description || oldItem?.description || "",
              available: oldItem?.available !== false
            };
          })
        };
      });
      if (JSON.stringify(oldCategories) !== JSON.stringify(nextCategories)) {
        config.categories = nextCategories;
        config.vkMenuUpdatedAt = new Date().toISOString();
        config.vkMenuSource = source;
        saveConfig(config);
        console.log("Menu synchronized from VK " + source, groupId);
      }
    } else {
      console.warn("No readable VK Market products or wall post headed МЕНЮ/ТОВАРЫ; existing menu preserved.");
    }

    // Synchronize community identity and visual elements when provided by VK.
    let appearanceChanged = false;
    const coverSizes = groupInfo.cover?.images || [];
    const cover = coverSizes.slice().sort((a, b) =>
      (Number(b.width || 0) * Number(b.height || 0)) -
      (Number(a.width || 0) * Number(a.height || 0))
    )[0]?.url || "";
    config.appearance = config.appearance || {};
    if (cover && config.appearance.bannerImage !== cover) {
      config.appearance.bannerImage = cover;
      appearanceChanged = true;
    }
    if (groupInfo.photo_200 && config.appearance.logoImage !== groupInfo.photo_200) {
      config.appearance.logoImage = groupInfo.photo_200;
      appearanceChanged = true;
    }
    if (groupInfo.name && config.shopName !== groupInfo.name) {
      config.shopName = groupInfo.name;
      appearanceChanged = true;
    }
    if (typeof groupInfo.description === "string" && config.subtitle !== groupInfo.description) {
      config.subtitle = groupInfo.description;
      appearanceChanged = true;
    }
    if (appearanceChanged) saveConfig(config);

    lastVkMenuSync = Date.now();
  } catch (error) {
    console.error("VK menu sync error:", error.message || error);
  } finally {
    vkMenuSyncInProgress = false;
  }
}

app.use(cors());
app.use(express.json({ limit: "100mb" }));

const DATA_FILE = path.join(__dirname, "data.json");

const defaultConfig = {
  shopName: "ШашлычОК",
  subtitle: "Вкусный шашлык с огня",
  appearance: {
    background: "#171717",
    accent: "#ff7518",
    text: "#ffffff",
    bannerImage: "",
    logoImage: ""
  },
  categories: [
    {
      id: "shashlyk",
      name: "Шашлык",
      items: [
        {
          id: "pork-neck",
          name: "Шашлык из свиной шеи",
          price: 0,
          photo: "",
          description: "",
          available: true
        },
        {
          id: "chicken",
          name: "Шашлык из курицы",
          price: 0,
          photo: "",
          description: "",
          available: true
        }
      ]
    }
  ],
  orderSettings: {
    deliveryEnabled: true,
    pickupEnabled: true,
    preorderEnabled: true
  }
};

function readConfig() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(defaultConfig, null, 2),
        "utf8"
      );
    }

    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (error) {
    console.error("Ошибка чтения data.json:", error);
    throw error;
  }
}

function saveConfig(config) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(config, null, 2), "utf8");
}

app.get("/", (req, res) => {
  res.send("ШашлычОК: сервер работает");
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "shashlychok-server" });
});

// Exchanges a VK ID authorization code using PKCE. The app secret is not embedded in the APK.
app.post("/api/auth/vk/exchange", async (req, res) => {
  const code = String(req.body?.code || "").trim();
  const deviceId = String(req.body?.device_id || "").trim();
  const codeVerifier = String(req.body?.code_verifier || "").trim();

  if (!code || !deviceId || !/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier)) {
    return res.status(400).json({ ok: false, error: "Данные авторизации VK ID неполные или неверные" });
  }

  const clientId = "54850632";
  const redirectUri = "vk54850632://vk.ru/blank.html";

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
      device_id: deviceId
    });

    const tokenResponse = await fetch("https://id.vk.ru/oauth2/auth?" + params.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code })
    });
    const tokenResult = await tokenResponse.json();

    if (!tokenResponse.ok || tokenResult.error || !tokenResult.access_token) {
      console.error("VK ID code exchange failed:", tokenResult.error || tokenResponse.status);
      return res.status(401).json({ ok: false, error: "ВКонтакте не подтвердил авторизацию. Проверь настройки VK ID." });
    }

    const userResponse = await fetch("https://id.vk.ru/oauth2/user_info?client_id=" + encodeURIComponent(clientId), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: tokenResult.access_token })
    });
    const userResult = await userResponse.json();

    const user = userResult.user;

    if (!userResponse.ok || userResult.error || !user?.user_id) {
      console.error("VK ID user info failed:", userResult.error || userResponse.status);
      return res.status(502).json({ ok: false, error: "Вход подтверждён не полностью. Попробуй ещё раз." });
    }

    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    return res.json({
      ok: true,
      user_id: String(user.user_id),
      name
    });
  } catch (error) {
    console.error("VK ID exchange request failed:", error);
    return res.status(502).json({ ok: false, error: "Ошибка связи с сервисом VK ID" });
  }
});

app.get("/api/config", async (req, res) => {
  try {
    await syncMenuFromVk();
    res.set("Cache-Control", "no-store");
    res.json(readConfig());
  } catch (error) {
    res.status(500).json({ error: "Не удалось загрузить настройки" });
  }
});

app.post("/api/orders", async (req, res) => {
  const token = process.env.VK_GROUP_TOKEN;
  const peerId = process.env.VK_PEER_ID;
  const message = req.body?.message;

  if (!token || !peerId) {
    return res.status(503).json({
      ok: false,
      error: "Сервер не настроен для ВКонтакте"
    });
  }

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      ok: false,
      error: "Текст заказа отсутствует"
    });
  }

  try {
    const params = new URLSearchParams({
      access_token: token,
      v: "5.199",
      peer_id: peerId,
      random_id: String(Date.now() % 2147483647),
      message: message.trim()
    });

    const response = await fetch(
      "https://api.vk.com/method/messages.send",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params
      }
    );

    const result = await response.json();

    if (!response.ok || result.error || !result.response) {
      console.error("Ошибка VK:", result.error || response.status);
      return res.status(502).json({
        ok: false,
        error: "ВКонтакте не принял заказ"
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Ошибка отправки:", error);
    return res.status(502).json({
      ok: false,
      error: "Ошибка связи с ВКонтакте"
    });
  }
});

app.put("/api/config", (req, res) => {
  if (!ADMIN_KEY) {
    return res.status(503).json({
      error: "Сначала настройте переменную ADMIN_KEY в Render"
    });
  }

  if (req.get("x-admin-key") !== ADMIN_KEY) {
    return res.status(401).json({ error: "Неверный ключ администратора" });
  }

  const config = req.body;

  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    !Array.isArray(config.categories) ||
    !config.appearance ||
    !config.orderSettings
  ) {
    return res.status(400).json({ error: "Неверный формат настроек" });
  }

  try {
    saveConfig(config);
    res.json({ ok: true, message: "Настройки сохранены" });
  } catch (error) {
    console.error("Ошибка сохранения:", error);
    res.status(500).json({ error: "Не удалось сохранить настройки" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ШашлычОК запущен на порту ${PORT}`);
});
