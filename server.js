
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;

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

app.get("/api/config", (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(readConfig());
  } catch (error) {
    res.status(500).json({ error: "Не удалось загрузить настройки" });
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
