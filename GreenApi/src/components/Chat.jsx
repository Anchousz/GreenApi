import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getGreenApiError, greenApi } from "../api/greenApi";

const MAX_MESSAGE_LENGTH = 4096;
const POLL_TIMEOUT_SECONDS = 25;
const CHAT_HISTORY_COUNT = 100;
const NEAR_BOTTOM_PX = 160;
const MOBILE_BREAKPOINT = 860;
const EMPTY_LIST = [];

const STATE_LABELS = {
  authorized: "Подключено",
  notAuthorized: "Не авторизовано",
  blocked: "Заблокировано",
  suspended: "Ограничено",
  starting: "Запускается",
  pendingPassword: "Ждёт 2FA",
};

// Типы вебхуков, из которых мы умеем достать текст
const TEXT_TYPES = new Set([
  "textMessage",
  "extendedTextMessage",
  "quotedMessage",
]);

/* ---------- утилиты ---------- */

// GREEN-API отдаёт секунды, а Date.now() — миллисекунды.
// Приводим всё к миллисекундам, иначе сортировка сообщений врёт.
function toMs(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return Date.now();
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(toMs(timestamp)));
}

// В списке чатов показываем только время, если это сегодня,
// иначе — короткую дату.
function formatListTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(toMs(timestamp));
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return formatTime(timestamp);
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

function extractWebhookText(messageData) {
  if (!messageData) return "";
  switch (messageData.typeMessage) {
    case "textMessage":
      return messageData.textMessageData?.textMessage || "";
    case "extendedTextMessage":
    case "quotedMessage":
      return messageData.extendedTextMessageData?.text || "";
    default:
      return "";
  }
}

function normalizeHistoryMessage(item, index) {
  const timestamp = toMs(item.timestamp);
  const isMine = item.type === "outgoing";

  return {
    id: item.idMessage
      ? String(item.idMessage)
      : `history-${timestamp}-${index}`,
    text: item.textMessage,
    isMine,
    timestamp,
    status: isMine ? item.statusMessage || "sent" : "received",
  };
}

function sortMessages(list) {
  return [...list].sort((a, b) => a.timestamp - b.timestamp);
}

// Сливаем два массива сообщений по id, чтобы вебхук и история не дублировались.
function mergeMessages(existing, incoming) {
  const map = new Map();
  [...existing, ...incoming].forEach((message) => {
    map.set(message.id, { ...map.get(message.id), ...message });
  });
  return sortMessages([...map.values()]);
}

// Пытаемся угадать, что пользователь ввёл в поле нового чата:
// телефон, @username или числовой chatId.
function normalizeTarget(rawValue) {
  const value = rawValue.trim();
  if (!value) return null;

  if (value.startsWith("@")) {
    return /^@[A-Za-z0-9_]{3,}$/.test(value)
      ? { kind: "username", value }
      : null;
  }

  if (/^-\d+$/.test(value)) {
    return { kind: "chatId", value };
  }

  if (!/^[+\d\s().-]+$/.test(value)) return null;

  const digits = value.replace(/\D/g, "");
  const looksLikePhone = /^\+|[\s().-]/.test(value) || digits.length >= 11;

  if (looksLikePhone) {
    if (digits.length < 8 || digits.length > 15) return null;
    let phone = digits.replace(/^00/, "");
    // 8XXXXXXXXXX — это российский формат, приводим к международному
    if (/^8\d{10}$/.test(phone)) phone = `7${phone.slice(1)}`;
    return { kind: "phone", value: phone };
  }

  return digits.length >= 5 ? { kind: "chatId", value: digits } : null;
}

function getChatTitle(chat) {
  return chat?.name || chat?.username || chat?.chatId || "Новый чат";
}

function getChatPreview(chat) {
  if (chat?.lastMessage) return chat.lastMessage;
  if (chat?.username) return chat.username;
  return chat?.chatId || "";
}

function normalizeChat(chat) {
  return { ...chat, chatId: String(chat.chatId) };
}

// Добавляет чат в список, не дёргая порядок — используется когда
// открываем новый чат, которого раньше не было.
function mergeChat(list, nextChat) {
  const index = list.findIndex((item) => item.chatId === nextChat.chatId);
  if (index === -1) return [nextChat, ...list];
  return list.map((item, i) => (i === index ? { ...item, ...nextChat } : item));
}

// Поднимает чат наверх — когда в нём новое сообщение.
function bumpChat(list, chatId, patch, defaults = {}) {
  const existing = list.find((item) => item.chatId === chatId);
  const cleanPatch = Object.fromEntries(
    Object.entries(patch).filter(
      ([, value]) => value !== undefined && value !== "",
    ),
  );
  const base = existing || {
    chatId,
    name: `Чат ${chatId}`,
    username: "",
    type: "user",
    ...defaults,
  };
  return [
    { ...base, ...cleanPatch },
    ...list.filter((item) => item.chatId !== chatId),
  ];
}

// Список с сервера уже отсортирован по активности.
// Но если локально у нас есть более свежее превью — оставляем его.
function mergeServerChats(server, local) {
  const localMap = new Map(local.map((chat) => [chat.chatId, chat]));
  const serverIds = new Set(server.map((chat) => chat.chatId));

  const merged = server.map((chat) => {
    const previous = localMap.get(chat.chatId);
    return previous
      ? {
          ...chat,
          lastMessage: previous.lastMessage,
          timestamp: previous.timestamp,
        }
      : chat;
  });

  return [...local.filter((chat) => !serverIds.has(chat.chatId)), ...merged];
}

function statusIcon(status) {
  if (status === "pending") return "🕓";
  if (status === "failed") return "!";
  if (status === "read" || status === "delivered") return "✓✓";
  return "✓";
}

/* ---------- компоненты ---------- */

const ChatListItem = memo(function ChatListItem({
  chat,
  isActive,
  unreadCount,
  onOpen,
}) {
  return (
    <button
      className={`chat-list-item ${isActive ? "active" : ""}`}
      onClick={() => onOpen(chat)}
      type="button"
    >
      <div className="list-avatar">
        {String(getChatTitle(chat)).slice(0, 1).toUpperCase()}
      </div>
      <div className="list-content">
        <div className="list-topline">
          <strong>{getChatTitle(chat)}</strong>
          <span>{formatListTime(chat.timestamp)}</span>
        </div>
        <div className="list-bottomline">
          <span>{getChatPreview(chat)}</span>
          {unreadCount > 0 && <b className="unread-badge">{unreadCount}</b>}
        </div>
      </div>
    </button>
  );
});

const MessageList = memo(function MessageList({ messages, onRetry }) {
  return (
    <>
      {messages.map((message) => (
        <div
          key={message.id}
          className={`message-row ${message.isMine ? "mine" : "theirs"}`}
        >
          <div
            className={`message-bubble ${message.status === "failed" ? "failed" : ""}`}
          >
            <div className="message-text">{message.text}</div>
            <div className="message-meta">
              {message.status === "failed" && (
                <button
                  className="retry-button"
                  type="button"
                  onClick={() => onRetry(message)}
                >
                  Не отправлено · повторить
                </button>
              )}
              <span>{formatTime(message.timestamp)}</span>
              {message.isMine && (
                <span className={`message-status status-${message.status}`}>
                  {statusIcon(message.status)}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </>
  );
});

function MessagesSkeleton() {
  return (
    <div className="messages-skeleton" aria-label="Загружаем историю">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className={`skeleton-bubble ${i % 2 ? "mine" : ""}`}
          style={{ width: `${38 + ((i * 17) % 30)}%` }}
        />
      ))}
    </div>
  );
}

function ChatListSkeleton() {
  return (
    <div className="chat-skeleton" aria-label="Загружаем чаты">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="chat-skeleton-row">
          <span className="skeleton-circle" />
          <span className="skeleton-lines">
            <i />
            <i />
          </span>
        </div>
      ))}
    </div>
  );
}

// Composer держит текст у себя, чтобы набор буквы не перерисовывал
// весь чат через родителя. Высота textarea растёт сама.
function Composer({ chatId, onSend }) {
  const [text, setText] = useState("");
  const textareaRef = useRef(null);

  useEffect(() => {
    if (window.matchMedia?.("(pointer: fine)").matches) {
      textareaRef.current?.focus();
    }
  }, [chatId]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [text]);

  const submit = (event) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText("");
    textareaRef.current?.focus();
  };

  const handleKeyDown = (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={MAX_MESSAGE_LENGTH}
        placeholder="Напишите сообщение…"
        rows={1}
        aria-label="Сообщение"
      />
      <div className="composer-side">
        <span className="char-counter">
          {text.length}/{MAX_MESSAGE_LENGTH}
        </span>
        <button
          className="send-button"
          type="submit"
          disabled={!text.trim()}
          aria-label="Отправить"
          title="Отправить"
        >
          ➤
        </button>
      </div>
    </form>
  );
}

/* ---------- основной экран ---------- */

export default function Chat({ credentials, onLogout }) {
  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [buckets, setBuckets] = useState({}); // { chatId: Message[] }
  const [chatSearch, setChatSearch] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [isLoadingChats, setIsLoadingChats] = useState(true);
  const [loadingHistoryFor, setLoadingHistoryFor] = useState("");
  const [isResolvingChat, setIsResolvingChat] = useState(false);
  const [stateInstance, setStateInstance] = useState("unknown");
  const [account, setAccount] = useState(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unread, setUnread] = useState({});
  const [lastErrorAt, setLastErrorAt] = useState(0);
  const [showJump, setShowJump] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(
    () => window.innerWidth <= MOBILE_BREAKPOINT,
  );

  const scrollRef = useRef(null);
  const activeChatRef = useRef("");
  const jumpRef = useRef(false); // при открытии чата прыгаем вниз моментально
  const nearBottomRef = useRef(true);
  const prevLengthRef = useRef(0);
  const historyInFlightRef = useRef(new Set());
  const loadedChatsRef = useRef(new Set());
  const seenNotificationsRef = useRef(new Set());

  // Polling должен жить всё время, пока открыт чат, и не перезапускаться
  // при каждом ререндере. Поэтому читаем credentials через ref.
  const credentialsRef = useRef(credentials);
  useEffect(() => {
    credentialsRef.current = credentials;
  }, [credentials]);

  const activeChatId = activeChat?.chatId || "";
  const messages = buckets[activeChatId] || EMPTY_LIST;
  const isLoadingHistory =
    Boolean(activeChatId) && loadingHistoryFor === activeChatId;
  const showSkeleton = isLoadingHistory && messages.length === 0;

  const showError = useCallback((message) => {
    setError(message);
    setLastErrorAt(Date.now());
  }, []);

  const updateBucket = useCallback((chatId, updater) => {
    setBuckets((current) => ({
      ...current,
      [chatId]: updater(current[chatId] || EMPTY_LIST),
    }));
  }, []);

  /* ----- состояние аккаунта и список чатов ----- */

  const refreshAccount = useCallback(async () => {
    try {
      const settings = await greenApi.getAccountSettings(credentials);
      const nextState = settings?.stateInstance || "unknown";

      setStateInstance(nextState);
      setAccount(settings || null);
      if (nextState === "authorized") setError("");
    } catch (apiError) {
      showError(
        getGreenApiError(
          apiError,
          "Не удалось получить состояние Telegram-инстанса.",
        ),
      );
    }
  }, [credentials, showError]);

  const refreshChats = useCallback(async () => {
    setIsLoadingChats(true);
    try {
      const nextChats = (await greenApi.getChats(credentials)).map(
        normalizeChat,
      );
      setChats((current) => mergeServerChats(nextChats, current));
    } catch (apiError) {
      showError(
        getGreenApiError(apiError, "Не удалось загрузить список чатов."),
      );
    } finally {
      setIsLoadingChats(false);
    }
  }, [credentials, showError]);

  useEffect(() => {
    // У разных методов GREEN-API свои лимиты по частоте,
    // поэтому запускаем параллельно, не ждём друг друга.
    refreshAccount();
    refreshChats();
  }, [refreshAccount, refreshChats]);

  /* ----- история сообщений ----- */

  const loadHistory = useCallback(
    async (chat) => {
      const { chatId } = chat;
      if (!chatId || historyInFlightRef.current.has(chatId)) return;

      historyInFlightRef.current.add(chatId);
      setLoadingHistoryFor(chatId);

      try {
        const history = await greenApi.getChatHistory(
          credentials,
          chatId,
          CHAT_HISTORY_COUNT,
        );
        const normalized = history
          .filter(
            (item) =>
              TEXT_TYPES.has(item?.typeMessage) &&
              typeof item?.textMessage === "string",
          )
          .map(normalizeHistoryMessage);

        // Пишем в бакет именно этого чата — вдруг юзер уже успел переключиться.
        updateBucket(chatId, (current) => mergeMessages(current, normalized));
        loadedChatsRef.current.add(chatId);

        const last = normalized.reduce(
          (a, b) => (!a || b.timestamp >= a.timestamp ? b : a),
          null,
        );
        if (last) {
          setChats((current) =>
            current.map((item) =>
              item.chatId === chatId &&
              (!item.timestamp || last.timestamp >= toMs(item.timestamp))
                ? { ...item, lastMessage: last.text, timestamp: last.timestamp }
                : item,
            ),
          );
        }
      } catch (apiError) {
        showError(
          getGreenApiError(apiError, "Не удалось загрузить историю чата."),
        );
      } finally {
        historyInFlightRef.current.delete(chatId);
        setLoadingHistoryFor((current) => (current === chatId ? "" : current));
      }
    },
    [credentials, showError, updateBucket],
  );

  const openChat = useCallback(
    (chat) => {
      if (activeChatRef.current !== chat.chatId) jumpRef.current = true;
      activeChatRef.current = chat.chatId;

      setActiveChat(chat);
      setMobileSidebarOpen(false);
      setError("");
      setUnread((current) => {
        if (!current[chat.chatId]) return current;
        const next = { ...current };
        delete next[chat.chatId];
        return next;
      });

      loadHistory(chat);
    },
    [loadHistory],
  );

  /* ----- создание нового чата ----- */

  const resolveChat = async (event) => {
    event.preventDefault();
    if (isResolvingChat || !targetInput.trim()) return;

    const target = normalizeTarget(targetInput);
    if (!target) {
      showError(
        "Неверный формат. Введите номер (+7 999 123-45-67), @username или числовой ID.",
      );
      return;
    }

    setIsResolvingChat(true);
    setError("");

    const kind = target.kind;
    const value = target.value;

    // Разные сообщения для номера и username — так понятнее, что не так
    const notFoundMessage =
      kind === "phone"
        ? "Номер скрыт или его не существует в Telegram."
        : "Пользователь с таким @username не найден или скрыт.";

    try {
      let chatId = value;
      let contact = null;

      // Номер и username надо сначала проверить через API.
      // chatId — сразу используем как есть.
      if (kind === "phone" || kind === "username") {
        let checkResult = null;
        let checkFailed = false;

        try {
          checkResult = await greenApi.checkAccount(credentials, target);
        } catch {
          // Для Telegram этот метод часто не поддерживается — значит, не нашли
          checkFailed = true;
        }

        if (
          checkFailed ||
          !checkResult ||
          checkResult.exist !== true ||
          !checkResult.chatId
        ) {
          throw new Error(notFoundMessage);
        }

        chatId = String(checkResult.chatId);
      }

      if (!chatId) throw new Error("Не удалось определить chatId.");

      // Имя тянем для красоты, но если не получится — не страшно.
      try {
        if (!chatId.startsWith("-")) {
          contact = await greenApi.getContactInfo(credentials, chatId);
        }
      } catch {
        // группы часто недоступны через getContactInfo
      }

      const existing = chats.find((item) => item.chatId === chatId);
      const chat = {
        ...existing,
        chatId,
        name:
          contact?.name ||
          contact?.contactName ||
          contact?.username ||
          existing?.name ||
          (kind === "username" ? value : `Чат ${chatId}`),
        username:
          contact?.username ||
          existing?.username ||
          (kind === "username" ? value : ""),
        type: contact?.chatType || existing?.type || "user",
        phoneNumber:
          contact?.phoneNumber ||
          existing?.phoneNumber ||
          (kind === "phone" ? Number(value) : 0),
      };

      setChats((current) => mergeChat(current, chat));
      setTargetInput("");
      setShowNewChat(false);
      openChat(chat);
      setNotice(`Чат «${getChatTitle(chat)}» открыт.`);
    } catch (apiError) {
      // Наши «понятные» ошибки показываем как есть,
      // всё остальное — через общий парсер.
      const isHumanMessage =
        apiError instanceof Error &&
        (apiError.message === notFoundMessage ||
          apiError.message.includes("Не удалось определить chatId"));

      if (isHumanMessage) {
        showError(apiError.message);
      } else {
        showError(getGreenApiError(apiError, "Не удалось открыть чат."));
      }
    } finally {
      setIsResolvingChat(false);
    }
  };

  /* ----- обработка входящих уведомлений ----- */

  const handleNotification = useCallback(
    (body) => {
      const type = body?.typeWebhook;

      if (type === "stateInstanceChanged" && body.stateInstance) {
        setStateInstance(body.stateInstance);
        return;
      }

      // Статус отправленного сообщения (прочитано / доставлено)
      if (type === "outgoingMessageStatus" && body.idMessage) {
        const id = String(body.idMessage);
        setBuckets((current) => {
          let changed = false;
          const next = {};
          Object.keys(current).forEach((chatId) => {
            next[chatId] = current[chatId].map((message) => {
              if (message.id !== id) return message;
              changed = true;
              return { ...message, status: body.status || message.status };
            });
          });
          return changed ? next : current;
        });
        return;
      }

      const isIncoming = type === "incomingMessageReceived";
      const isOutgoing =
        type === "outgoingMessageReceived" ||
        type === "outgoingAPIMessageReceived";
      if (!isIncoming && !isOutgoing) return;

      const text = extractWebhookText(body.messageData);
      const chatId = body?.senderData?.chatId
        ? String(body.senderData.chatId)
        : "";
      if (!chatId || !text.trim()) return;

      const timestamp = toMs(body.timestamp);
      const id = body.idMessage
        ? String(body.idMessage)
        : `notification-${timestamp}-${Math.random()}`;
      const isNew = !seenNotificationsRef.current.has(id);
      seenNotificationsRef.current.add(id);

      updateBucket(chatId, (current) =>
        mergeMessages(current, [
          {
            id,
            text,
            isMine: isOutgoing,
            timestamp,
            status: isOutgoing ? "sent" : "received",
          },
        ]),
      );

      // Плюс к счётчику непрочитанных — только если это неактивный чат
      if (isIncoming && isNew && chatId !== activeChatRef.current) {
        setUnread((current) => ({
          ...current,
          [chatId]: (current[chatId] || 0) + 1,
        }));
      }

      // senderName — это имя человека в группе, не название чата.
      // Используем его только как имя для чата, который мы ещё не знаем.
      const fallbackName =
        body?.senderData?.chatName ||
        (isIncoming ? body?.senderData?.senderName : "") ||
        `Чат ${chatId}`;

      setChats((current) =>
        bumpChat(
          current,
          chatId,
          {
            name: body?.senderData?.chatName,
            type: body?.senderData?.chatType,
            lastMessage: text,
            timestamp,
          },
          { name: fallbackName },
        ),
      );
    },
    [updateBucket],
  );

  // Держим свежую версию handleNotification в ref, чтобы polling-эффект
  // ниже не пересоздавался каждый раз при обновлении состояния.
  const handleNotificationRef = useRef(handleNotification);
  useEffect(() => {
    handleNotificationRef.current = handleNotification;
  }, [handleNotification]);

  /* ----- long polling ----- */

  useEffect(() => {
    let stopped = false;
    let timer = null;
    let failures = 0;

    const sleep = (ms) =>
      new Promise((resolve) => {
        timer = window.setTimeout(resolve, ms);
      });

    // 408, 404, ECONNABORTED, ETIMEDOUT и просто «нет ответа» — это НЕ ошибка.
    // Long polling всегда так заканчивается, когда новых сообщений нет.
    const isTimeoutLike = (error) => {
      const status = error?.response?.status;
      if (status === 408 || status === 404) return true;
      const code = error?.code;
      if (code === "ECONNABORTED" || code === "ETIMEDOUT") return true;
      if (!error?.response) return true;
      return false;
    };

    const runPolling = async () => {
      while (!stopped) {
        try {
          const notification = await greenApi.receiveNotification(
            credentialsRef.current,
            POLL_TIMEOUT_SECONDS,
          );
          if (stopped) break;

          failures = 0;
          setConnectionLost(false);

          if (notification?.body) {
            handleNotificationRef.current(notification.body);

            if (notification.receiptId != null) {
              try {
                await greenApi.deleteNotification(
                  credentialsRef.current,
                  notification.receiptId,
                );
              } catch {
                // Не глушим polling из-за ошибки удаления — просто подождём
                await sleep(300);
              }
            }

            // Возможно, в очереди ещё уведомления — сразу идём за следующим
            continue;
          }

          // Пусто — короткая пауза, чтобы не ддосить прокси
          await sleep(200);
        } catch (apiError) {
          if (stopped) break;

          if (isTimeoutLike(apiError)) {
            await sleep(150);
            continue;
          }

          // Настоящая ошибка (сеть, 500, сервер недоступен)
          failures += 1;
          if (failures >= 2) setConnectionLost(true);

          const status = apiError?.response?.status;
          // Показываем только один раз за серию и не для 429 (это временно)
          if (failures === 1 && status !== 429) {
            showError(
              getGreenApiError(
                apiError,
                "Не удалось получить новые сообщения.",
              ),
            );
          }

          await sleep(Math.min(1500 * failures, 10000));
        }
      }
    };

    runPolling();

    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
    // Пустой массив: polling запускается один раз и живёт весь жизненный цикл.
    // credentials и handleNotification читаем через refs — они не перезапустят эффект.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- скролл сообщений ----- */

  const scrollToBottom = useCallback((behavior = "smooth") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distance < NEAR_BOTTOM_PX;
    nearBottomRef.current = near;
    setShowJump((current) => (current === !near ? current : !near));
  }, []);

  // useLayoutEffect — чтобы при открытии чата список мгновенно оказался внизу,
  // без видимой перемотки. Плавный скролл только для новых сообщений.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeChatId) return;

    if (jumpRef.current) {
      if (showSkeleton) return; // ещё нечего показывать
      el.scrollTop = el.scrollHeight;
      jumpRef.current = false;
      prevLengthRef.current = messages.length;
      nearBottomRef.current = true;
      setShowJump(false);
      return;
    }

    if (messages.length > prevLengthRef.current) {
      const last = messages[messages.length - 1];
      if (last?.isMine || nearBottomRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else {
        setShowJump(true);
      }
    }
    prevLengthRef.current = messages.length;
  }, [messages, activeChatId, showSkeleton]);

  /* ----- тосты ----- */

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!error || !lastErrorAt) return undefined;
    const timer = window.setTimeout(() => setError(""), 7000);
    return () => window.clearTimeout(timer);
  }, [error, lastErrorAt]);

  /* ----- отправка ----- */

  const deliver = useCallback(
    async (chatId, tempId, text) => {
      try {
        const result = await greenApi.sendMessage(credentials, chatId, text);
        const serverId = result?.idMessage ? String(result.idMessage) : null;
        if (serverId) seenNotificationsRef.current.add(serverId);

        updateBucket(chatId, (list) => {
          if (!serverId) {
            return list.map((m) =>
              m.id === tempId ? { ...m, status: "sent" } : m,
            );
          }
          // Вебхук outgoingAPIMessageReceived может обогнать ответ sendMessage.
          // Если он уже здесь — просто убираем временное сообщение.
          if (list.some((m) => m.id === serverId)) {
            return list.filter((m) => m.id !== tempId);
          }
          return list.map((m) =>
            m.id === tempId ? { ...m, id: serverId, status: "sent" } : m,
          );
        });
      } catch (apiError) {
        updateBucket(chatId, (list) =>
          list.map((m) => (m.id === tempId ? { ...m, status: "failed" } : m)),
        );
        showError(getGreenApiError(apiError, "Сообщение не отправлено."));
      }
    },
    [credentials, showError, updateBucket],
  );

  const sendMessage = useCallback(
    (text) => {
      if (!activeChat) return;

      if (text.length > MAX_MESSAGE_LENGTH) {
        showError(
          `Telegram-сообщение не должно превышать ${MAX_MESSAGE_LENGTH} символов.`,
        );
        return;
      }

      const { chatId } = activeChat;
      const timestamp = Date.now();
      const tempId = `pending-${timestamp}-${Math.random().toString(36).slice(2, 7)}`;

      setError("");
      updateBucket(chatId, (list) => [
        ...list,
        { id: tempId, text, isMine: true, timestamp, status: "pending" },
      ]);
      setChats((current) =>
        bumpChat(current, chatId, { lastMessage: text, timestamp }, activeChat),
      );

      deliver(chatId, tempId, text);
    },
    [activeChat, deliver, showError, updateBucket],
  );

  const retryMessage = useCallback(
    (message) => {
      if (!activeChatId) return;
      updateBucket(activeChatId, (list) =>
        list.map((m) =>
          m.id === message.id ? { ...m, status: "pending" } : m,
        ),
      );
      deliver(activeChatId, message.id, message.text);
    },
    [activeChatId, deliver, updateBucket],
  );

  /* ----- производные значения ----- */

  const filteredChats = useMemo(() => {
    const query = chatSearch.trim().toLowerCase();
    if (!query) return chats;

    return chats.filter((chat) => {
      const source = [chat.name, chat.username, chat.chatId]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return source.includes(query);
    });
  }, [chats, chatSearch]);

  const stateLabel =
    STATE_LABELS[stateInstance] ||
    (stateInstance === "unknown" ? "Проверяем подключение…" : stateInstance);
  const statusClass =
    stateInstance === "authorized" && !connectionLost ? "online" : "offline";

  const refreshAll = () => {
    refreshAccount();
    refreshChats();
  };

  return (
    <main className="messenger-shell">
      {mobileSidebarOpen && (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="Закрыть список чатов"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <aside className={`sidebar ${mobileSidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-head">
          <div className="account-avatar">T</div>
          <div className="account-info">
            <strong>{account?.username || account?.phone || "Telegram"}</strong>
            <span>
              {account?.phone ? `+${account.phone}` : "GREEN-API client"}
            </span>
          </div>
          <button
            className="icon-button top-icon"
            onClick={onLogout}
            title="Выйти"
            aria-label="Выйти"
          >
            ↪
          </button>
        </div>

        <div className="connection-banner">
          <span className={`status-dot ${statusClass}`} />
          <span>{connectionLost ? "Нет связи с GREEN-API" : stateLabel}</span>
          {account?.historySyncProgress != null &&
            account.historySyncProgress < 100 && (
              <span className="sync-progress">
                • синхронизация {account.historySyncProgress}%
              </span>
            )}
          <button className="text-button" onClick={refreshAll} type="button">
            Обновить
          </button>
        </div>

        <div className="chat-tools">
          <div className="search-box">
            <span>⌕</span>
            <input
              value={chatSearch}
              onChange={(event) => setChatSearch(event.target.value)}
              placeholder="Поиск"
              aria-label="Поиск чатов"
            />
          </div>
          <button
            className="new-chat-button"
            type="button"
            onClick={() => setShowNewChat((value) => !value)}
            title="Новый чат"
            aria-label="Новый чат"
          >
            +
          </button>
        </div>

        {showNewChat && (
          <form className="new-chat-panel" onSubmit={resolveChat}>
            <input
              value={targetInput}
              onChange={(event) => setTargetInput(event.target.value)}
              placeholder="+7 999 123-45-67, @username или 123456789"
              aria-label="Получатель"
              autoFocus
              spellCheck="false"
            />
            <button
              className="primary-button"
              type="submit"
              disabled={isResolvingChat}
            >
              {isResolvingChat ? "Ищу…" : "Создать чат"}
            </button>
            <div className="field-hint">
              Номер — должен быть в контактах юзербота. <br />
              @username — если Telegram-юзербот умеет его находить. <br />
              Числовой ID — самый надёжный способ (узнать через @userinfobot).
            </div>
          </form>
        )}

        <div className="chat-list-scroll">
          {isLoadingChats && chats.length === 0 ? (
            <ChatListSkeleton />
          ) : filteredChats.length === 0 ? (
            <div className="sidebar-state">
              {chatSearch
                ? "Ничего не найдено"
                : "Чатов пока нет. Нажмите «+», чтобы начать."}
            </div>
          ) : (
            filteredChats.map((chat) => (
              <ChatListItem
                key={chat.chatId}
                chat={chat}
                isActive={activeChatId === chat.chatId}
                unreadCount={unread[chat.chatId] || 0}
                onOpen={openChat}
              />
            ))
          )}
        </div>
      </aside>

      <section className="chat-panel">
        <header className="chat-topbar">
          <button
            className="mobile-menu-button"
            type="button"
            onClick={() => setMobileSidebarOpen(true)}
            aria-label="Открыть список чатов"
          >
            ☰
          </button>

          {activeChat ? (
            <>
              <div className="chat-avatar">
                {String(getChatTitle(activeChat)).slice(0, 1).toUpperCase()}
              </div>
              <div className="chat-title-block">
                <strong>{getChatTitle(activeChat)}</strong>
                <span>
                  {activeChat.username || activeChat.chatId}
                  {activeChat.type ? ` · ${activeChat.type}` : ""}
                </span>
              </div>
              <button
                className="ghost-button"
                type="button"
                onClick={() => loadHistory(activeChat)}
                disabled={isLoadingHistory}
              >
                {isLoadingHistory ? "Загрузка…" : "Обновить историю"}
              </button>
            </>
          ) : (
            <div className="chat-title-block">
              <strong>Выберите чат</strong>
              <span>Текстовые сообщения через GREEN-API</span>
            </div>
          )}
        </header>

        {error && (
          <div className="toast toast-error" role="alert">
            {error}
          </div>
        )}
        {notice && <div className="toast toast-success">{notice}</div>}

        {activeChat &&
          stateInstance !== "authorized" &&
          stateInstance !== "unknown" && (
            <div className="connection-warning">
              Состояние инстанса: <strong>{stateLabel}</strong>. Текст можно
              набрать и отправить; если GREEN-API не готов, приложение покажет
              ошибку отправки.
            </div>
          )}

        {!activeChat ? (
          <div className="empty-chat">
            <div className="empty-icon">✈</div>
            <h2>Ваши сообщения</h2>
            <p>
              Откройте чат слева или создайте новый по номеру телефона
              получателя.
            </p>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                setShowNewChat(true);
                setMobileSidebarOpen(true);
              }}
            >
              Создать чат
            </button>
          </div>
        ) : (
          <>
            <div className="messages-wrap">
              <div
                className="messages-area"
                ref={scrollRef}
                onScroll={handleScroll}
              >
                {showSkeleton ? (
                  <MessagesSkeleton />
                ) : messages.length === 0 ? (
                  <div className="messages-state">
                    <span>Чат пустой</span>
                    <small>Напишите первое сообщение ниже.</small>
                  </div>
                ) : (
                  <MessageList messages={messages} onRetry={retryMessage} />
                )}
              </div>
              {showJump && messages.length > 0 && (
                <button
                  className="jump-bottom"
                  type="button"
                  onClick={() => scrollToBottom("smooth")}
                  aria-label="К последним сообщениям"
                  title="К последним сообщениям"
                >
                  ↓
                </button>
              )}
            </div>

            <Composer
              key={activeChatId}
              chatId={activeChatId}
              onSend={sendMessage}
            />
          </>
        )}
      </section>
    </main>
  );
}
