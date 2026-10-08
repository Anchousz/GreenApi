import axios from "axios";

// Все запросы идут через локальный прокси Vite — так решаем CORS
// и не светим реальный apiUrl инстанса в JS фронта.
const LOCAL_PROXY_PREFIX = "/api/green";
const REQUEST_TIMEOUT = 30_000;

function normalizeApiUrl(apiUrl) {
  const raw = String(apiUrl || "").trim();
  if (!raw) {
    throw new Error("Укажите apiUrl именно вашего GREEN-API инстанса.");
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  url.pathname = url.pathname.replace(/\/+$/, "");

  if (url.protocol !== "https:") {
    throw new Error("API URL должен использовать HTTPS.");
  }

  if (!/green-api\.com$/i.test(url.hostname)) {
    throw new Error("API URL должен указывать на GREEN-API.");
  }

  return url.toString().replace(/\/$/, "");
}

function buildProxyUrl({ idInstance, apiTokenInstance }, method) {
  const id = encodeURIComponent(String(idInstance).trim());
  const token = encodeURIComponent(String(apiTokenInstance).trim());
  return `${LOCAL_PROXY_PREFIX}/waInstance${id}/${method}/${token}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GREEN-API режет частоту некоторых методов (getChatHistory, getChats,
// getAccountSettings) до ~1 запроса в секунду на инстанс. Чтобы быстрое
// переключение между чатами не вылетало с 429, ставим такие запросы в
// очередь: следующий стартует только когда предыдущий закончился + пауза.
const throttleChains = new Map();

function throttled(key, gapMs, task) {
  const previous = throttleChains.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  throttleChains.set(
    key,
    run.then(
      () => sleep(gapMs),
      () => sleep(gapMs),
    ),
  );
  return run;
}

function clientRequest(credentials, config, { retries = 3 } = {}) {
  const send = () =>
    axios({
      ...config,
      timeout: config.timeout ?? REQUEST_TIMEOUT,
      url: config.url,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        // Эти три заголовка читает наш прокси в vite.config.js
        "X-Green-API-URL": normalizeApiUrl(credentials.apiUrl),
        "X-Green-API-Instance": String(credentials.idInstance).trim(),
        "X-Green-API-Token": String(credentials.apiTokenInstance).trim(),
        ...(config.headers || {}),
      },
    });

  // Автоматический retry, но только для 429 (too many requests).
  // Если сервер прислал retry-after — уважаем его, иначе ждём ~1.3 сек.
  const attempt = async (left) => {
    try {
      return await send();
    } catch (error) {
      if (
        left > 0 &&
        axios.isAxiosError(error) &&
        error.response?.status === 429
      ) {
        const retryAfter = Number(error.response.headers?.["retry-after"]);
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 1300;
        await sleep(delay);
        return attempt(left - 1);
      }
      throw error;
    }
  };

  return attempt(retries);
}

// apiUrl инстанса строится из первых 4 цифр idInstance:
// 7103123456 → https://7103.api.green-api.com
// Пользователю достаточно ввести idInstance и apiTokenInstance.
export function deriveApiUrl(idInstance) {
  const id = String(idInstance || "").trim();
  if (id.length < 4) return "";
  return `https://${id.slice(0, 4)}.api.green-api.com`;
}

// Превращаем любую ошибку axios в понятный текст для пользователя.
export function getGreenApiError(
  error,
  fallback = "Произошла ошибка запроса к GREEN-API.",
) {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;

    // 466 — особый случай: превышен лимит тарифа Developer
    if (error.response?.status === 466) {
      return "Достигнут лимит тарифа GREEN-API (на тарифе Developer доступно только 3 чата). Используйте один из уже открытых чатов.";
    }

    if (typeof data?.message === "string" && data.message.trim()) {
      return data.message.trim();
    }

    if (typeof data?.reason === "string" && data.reason.trim()) {
      return data.reason.trim();
    }

    if (typeof data?.error === "string" && data.error.trim()) {
      return data.error.trim();
    }

    if (typeof data?.status === "string" && data.status !== "error") {
      return data.status;
    }

    if (error.response?.status === 429) {
      const retryAfter = error.response.headers?.["retry-after"];
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        return `GREEN-API временно ограничил частоту запросов. Повторите через ${Math.ceil(seconds)} сек.`;
      }
      return "GREEN-API временно ограничил частоту запросов (429). Подождите около 1–2 секунд и повторите действие.";
    }

    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return "Запрос превысил допустимое время ожидания.";
    }

    if (!error.response) {
      return "Не удалось связаться с локальным API-прокси. Проверьте, что приложение запущено через npm run dev.";
    }

    return `GREEN-API вернул HTTP ${error.response.status}.`;
  }

  return error instanceof Error ? error.message : fallback;
}

export const greenApi = {
  async getStateInstance(credentials) {
    const response = await clientRequest(credentials, {
      method: "GET",
      url: buildProxyUrl(credentials, "getStateInstance"),
    });
    return response.data;
  },

  async getAccountSettings(credentials) {
    const response = await throttled("getAccountSettings", 1100, () =>
      clientRequest(credentials, {
        method: "GET",
        url: buildProxyUrl(credentials, "getAccountSettings"),
      }),
    );
    return response.data;
  },

  async getChats(credentials) {
    const response = await throttled("getChats", 1100, () =>
      clientRequest(credentials, {
        method: "GET",
        url: buildProxyUrl(credentials, "getChats"),
      }),
    );
    return Array.isArray(response.data) ? response.data : [];
  },

  // Проверка: существует ли аккаунт по номеру или username.
  // Для Telegram-юзербота часто возвращает { exist: false } —
  // это нормально, API просто не умеет искать по этим данным.
  async checkAccount(credentials, target) {
    const payload =
      target.kind === "username"
        ? { username: target.value }
        : { phoneNumber: Number(target.value), force: true };

    const response = await clientRequest(credentials, {
      method: "POST",
      url: buildProxyUrl(credentials, "checkAccount"),
      data: payload,
    });
    return response.data;
  },

  async getContactInfo(credentials, chatId) {
    const response = await clientRequest(credentials, {
      method: "POST",
      url: buildProxyUrl(credentials, "getContactInfo"),
      data: { chatId },
    });
    return response.data;
  },

  async getChatHistory(credentials, chatId, count = 100) {
    const response = await throttled("getChatHistory", 1100, () =>
      clientRequest(credentials, {
        method: "POST",
        url: buildProxyUrl(credentials, "getChatHistory"),
        data: { chatId, count },
      }),
    );
    return Array.isArray(response.data) ? response.data : [];
  },

  async sendMessage(credentials, chatId, message) {
    const response = await clientRequest(credentials, {
      method: "POST",
      url: buildProxyUrl(credentials, "sendMessage"),
      data: { chatId, message },
    });
    return response.data;
  },

  // Long polling: сервер держит соединение до `receiveTimeout` секунд.
  // Если за это время ничего не пришло — соединение закрывается,
  // и polling-цикл в Chat.jsx открывает новое.
  async receiveNotification(credentials, receiveTimeout = 25) {
    const response = await clientRequest(credentials, {
      method: "GET",
      url: buildProxyUrl(credentials, "receiveNotification"),
      params: { receiveTimeout },
      // Даём серверу +10 сек форы, чтобы axios не убил запрос
      // раньше, чем сам сервер закроет соединение.
      timeout: (receiveTimeout + 10) * 1000,
    });

    return response.data || null;
  },

  async deleteNotification(credentials, receiptId) {
    const response = await clientRequest(credentials, {
      method: "DELETE",
      url: `${buildProxyUrl(credentials, "deleteNotification")}/${encodeURIComponent(String(receiptId))}`,
    });
    return response.data;
  },
};