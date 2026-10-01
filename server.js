// Локальный запуск рисовалки без Vercel CLI.
// Раздаёт index.html и эмулирует serverless-функцию api/gigachat.js на обычном Express.
require("dotenv").config();
const express = require("express");
const gigachat = require("./api/gigachat.js");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.post("/api/gigachat", (req, res) => {
  gigachat(req, res).catch((e) => {
    console.error("Unhandled proxy error", e);
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Рисовалка запущена: http://localhost:${PORT}`);
});
