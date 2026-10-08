import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const GREEN_PROXY_PREFIX = "/api/green";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Проксирует /api/green/... на apiUrl конкретного инстанса.
// Адрес приходит в заголовке X-Green-API-URL. Нужен, чтобы:
//   1) обойти CORS (браузер видит только наш localhost),
//   2) не светить apiUrl инстанса в JS-бандле фронта.
async function greenProxyHandler(req, res) {
  try {
    const apiUrl = String(req.headers["x-green-api-url"] || "").trim();

    if (!apiUrl) {
      sendJson(res, 400, { message: "Missing X-Green-API-URL header." });
      return;
    }

    const base = new URL(apiUrl);

    if (base.protocol !== "https:") {
      throw new Error("GREEN-API URL must use HTTPS.");
    }

    if (!/(^|\.)green-api\.com$/i.test(base.hostname)) {
      throw new Error("GREEN-API URL must point to green-api.com.");
    }

    const requestUrl = new URL(req.url || "/", "http://localhost");
    const upstreamUrl = `${base.origin}${base.pathname.replace(/\/+$/, "")}${requestUrl.pathname}${requestUrl.search}`;
    const method = req.method || "GET";
    const headers = { Accept: "application/json" };

    if (req.headers["content-type"]) {
      headers["Content-Type"] = req.headers["content-type"];
    }

    const body =
      method !== "GET" && method !== "HEAD" ? await readBody(req) : undefined;

    const upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers,
      body: body?.length ? body : undefined,
    });

    res.statusCode = upstreamResponse.status;
    res.statusMessage = upstreamResponse.statusText;

    // Эти заголовки описывают исходное соединение — для нас они не актуальны,
    // а некоторые (content-length) могут поломать ответ, если тело пережато.
    upstreamResponse.headers.forEach((value, key) => {
      if (
        key === "transfer-encoding" ||
        key === "content-encoding" ||
        key === "content-length" ||
        key === "connection"
      ) {
        return;
      }
      res.setHeader(key, value);
    });

    res.end(Buffer.from(await upstreamResponse.arrayBuffer()));
  } catch (error) {
    sendJson(res, 502, {
      message:
        error instanceof Error ? error.message : "GREEN-API proxy error.",
      code: "GREEN_PROXY_ERROR",
    });
  }
}

function greenApiProxyPlugin() {
  return {
    name: "green-api-dynamic-proxy",
    // Подключаем прокси и к dev-серверу, и к preview
    configureServer(server) {
      server.middlewares.use(GREEN_PROXY_PREFIX, greenProxyHandler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(GREEN_PROXY_PREFIX, greenProxyHandler);
    },
  };
}

export default defineConfig({
  plugins: [react(), greenApiProxyPlugin()],
  server: {
    host: "0.0.0.0",
    port: 3000,
  },
});