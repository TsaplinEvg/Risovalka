// Посредник между рисовалкой и GigaChat (Vercel Serverless Function, Node.js).
// Ключ GigaChat хранится в переменных окружения Vercel и в браузер не попадает.
//
// Переменные окружения (Vercel → Project → Settings → Environment Variables):
//   GIGACHAT_AUTH_KEY  — «Authorization key» из личного кабинета GigaChat (обязательно)
//   GIGACHAT_SCOPE     — GIGACHAT_API_PERS для физлиц (по умолчанию)
//   GIGACHAT_MODEL     — модель по умолчанию, например GigaChat (по умолчанию)
//   APP_PASSWORD       — пароль рисовалки, чтобы чужие не тратили токены (желательно)
//   GIGACHAT_CA_CERT   — корневой сертификат Минцифры в формате PEM (необязательно, см. README)

const https = require("https");
const crypto = require("crypto");

const OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const CHAT_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions";
const FILE_URL = (id) => "https://gigachat.devices.sberbank.ru/api/v1/files/" + id + "/content";

let cachedToken = null;
let cachedExp = 0;

function makeAgent() {
  const ca = process.env.GIGACHAT_CA_CERT;
  if (ca) return new https.Agent({ ca: ca.replace(/\\n/g, "\n") });
  // Без сертификата Минцифры Node.js не доверяет серверам GigaChat.
  // Отключаем проверку только для этих запросов. Надёжнее задать GIGACHAT_CA_CERT.
  return new https.Agent({ rejectUnauthorized: false });
}
const agent = makeAgent();

function request(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, text: data }));
      }
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
    req.on("error", reject);
    req.end(body);
  });
}

// GET бинарного файла (скачивание картинки) — request() выше читает ответ как utf8-текст,
// для JPEG это испортит байты, поэтому тут собираем Buffer-чанки.
function requestBinaryGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "GET", headers, agent, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
      }
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
    req.on("error", reject);
    req.end();
  });
}

function fail(status, code, detail) {
  return Object.assign(new Error(code), { status, code, detail: String(detail || "").slice(0, 300) });
}

async function getToken(force) {
  if (!force && cachedToken && Date.now() < cachedExp - 60_000) return cachedToken;
  const key = process.env.GIGACHAT_AUTH_KEY;
  if (!key) throw fail(500, "no_server_key");

  let r;
  try {
    r = await request(
      OAUTH_URL,
      {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        RqUID: crypto.randomUUID(),
        Authorization: "Basic " + key.trim(),
      },
      "scope=" + encodeURIComponent(process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS"),
      15_000
    );
  } catch (e) {
    throw fail(502, e.code === "timeout" ? "timeout" : "gigachat_unreachable", e.message);
  }
  if (r.status !== 200) throw fail(502, "oauth_failed", r.status + " " + r.text);

  let d;
  try { d = JSON.parse(r.text); } catch { throw fail(502, "oauth_failed", "bad json"); }
  if (!d.access_token) throw fail(502, "oauth_failed", "no access_token");
  cachedToken = d.access_token;
  cachedExp = Number(d.expires_at) || Date.now() + 25 * 60_000;
  return cachedToken;
}

async function chat(token, model, prompt) {
  try {
    return await request(
      CHAT_URL,
      { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
      JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.7 }),
      50_000
    );
  } catch (e) {
    throw fail(e.code === "timeout" ? 504 : 502, e.code === "timeout" ? "timeout" : "gigachat_unreachable", e.message);
  }
}

// Экспериментальный режим "настоящего" рисунка: встроенная в GigaChat генерация
// изображений (Kandinsky) через function_call. Ответ — текст с тегом
// <img src="FILE_ID" fuse="true"/>, сама картинка скачивается отдельным запросом.
async function chatImage(token, model, prompt) {
  try {
    return await request(
      CHAT_URL,
      { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
      JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Ты — добрый детский художник. Рисуй простые, яркие, добрые картинки для детей, без жести и реализма ужасов." },
          { role: "user", content: prompt }
        ],
        function_call: "auto"
      }),
      90_000
    );
  } catch (e) {
    throw fail(e.code === "timeout" ? 504 : 502, e.code === "timeout" ? "timeout" : "gigachat_unreachable", e.message);
  }
}

async function downloadFile(token, fileId) {
  try {
    return await requestBinaryGet(FILE_URL(fileId), { Accept: "application/jpg", Authorization: "Bearer " + token }, 30_000);
  } catch (e) {
    throw fail(e.code === "timeout" ? 504 : 502, e.code === "timeout" ? "timeout" : "gigachat_unreachable", e.message);
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const pw = process.env.APP_PASSWORD;
  if (pw && req.headers["x-app-password"] !== pw) return res.status(403).json({ error: "bad_password" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const prompt = body && typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt || prompt.length > 200_000) return res.status(400).json({ error: "bad_prompt" });

  let model = process.env.GIGACHAT_MODEL || "GigaChat";
  if (body && typeof body.model === "string" && /^[\w.\-]{1,60}$/.test(body.model)) model = body.model;

  if (body && body.mode === "image") {
    try {
      let r = await chatImage(await getToken(false), model, prompt);
      if (r.status === 401) r = await chatImage(await getToken(true), model, prompt);
      if (r.status === 429) return res.status(429).json({ error: "rate_limited" });
      if (r.status !== 200) {
        console.error("GigaChat image error", r.status, r.text.slice(0, 500));
        return res.status(502).json({ error: "gigachat_" + r.status, detail: r.text.slice(0, 300) });
      }
      let d;
      try { d = JSON.parse(r.text); } catch { return res.status(502).json({ error: "empty" }); }
      const content = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      const m = typeof content === "string" && content.match(/src="([a-zA-Z0-9-]{10,})"/);
      if (!m) return res.status(502).json({ error: "no_image", detail: String(content || "").slice(0, 200) });
      const fileRes = await downloadFile(await getToken(false), m[1]);
      if (fileRes.status !== 200) return res.status(502).json({ error: "file_" + fileRes.status });
      return res.status(200).json({ image: "data:image/jpeg;base64," + fileRes.buffer.toString("base64") });
    } catch (e) {
      console.error("Proxy image error", e.code, e.detail || e.message);
      return res.status(e.status || 502).json({ error: e.code || "gigachat_unreachable", detail: e.detail || "" });
    }
  }

  try {
    let r = await chat(await getToken(false), model, prompt);
    if (r.status === 401) r = await chat(await getToken(true), model, prompt); // токен протух
    if (r.status === 429) return res.status(429).json({ error: "rate_limited" });
    if (r.status !== 200) {
      console.error("GigaChat error", r.status, r.text.slice(0, 500));
      return res.status(502).json({ error: "gigachat_" + r.status, detail: r.text.slice(0, 300) });
    }
    let d;
    try { d = JSON.parse(r.text); } catch { return res.status(502).json({ error: "empty" }); }
    const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!text) return res.status(502).json({ error: "empty" });
    return res.status(200).json({ text });
  } catch (e) {
    console.error("Proxy error", e.code, e.detail || e.message);
    return res.status(e.status || 502).json({ error: e.code || "gigachat_unreachable", detail: e.detail || "" });
  }
};
