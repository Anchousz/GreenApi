import { useState } from "react";
import { deriveApiUrl } from "../api/greenApi";

const DEFAULT_API_URL = "";

export default function Login({ onLogin }) {
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [idInstance, setIdInstance] = useState("");
  const [apiTokenInstance, setApiTokenInstance] = useState("");
  const [remember, setRemember] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = (event) => {
    event.preventDefault();
    setError("");

    const cleanId = idInstance.trim();
    const cleanToken = apiTokenInstance.trim();
    // apiUrl можно не вводить — по умолчанию строим его из первых 4 цифр idInstance
    const cleanUrl = apiUrl.trim().replace(/\/+$/, "") || deriveApiUrl(cleanId);

    if (!cleanId || !cleanToken) {
      setError("Заполните idInstance и apiTokenInstance.");
      return;
    }

    if (!/^\d+$/.test(cleanId) || cleanId.length < 4) {
      setError("idInstance должен содержать только цифры (не меньше 4).");
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(
        /^https?:\/\//i.test(cleanUrl) ? cleanUrl : `https://${cleanUrl}`,
      );
    } catch {
      setError("API URL имеет неверный формат.");
      return;
    }

    // Общий api.green-api.com не подходит — у каждого инстанса свой поддомен
    if (/^api\.green-api\.com$/i.test(parsedUrl.hostname)) {
      setError(
        "Укажите apiUrl именно вашего инстанса (например, https://7103.api.green-api.com) или оставьте поле пустым.",
      );
      return;
    }

    if (!/green-api\.com$/i.test(parsedUrl.hostname)) {
      setError("API URL должен указывать на GREEN-API.");
      return;
    }

    onLogin(
      {
        apiUrl: parsedUrl.toString().replace(/\/$/, ""),
        idInstance: cleanId,
        apiTokenInstance: cleanToken,
      },
      remember,
    );
  };

  return (
    <main className="auth-page">
      <section className="auth-card" aria-label="Авторизация GREEN-API">
        <div className="auth-brand">
          <div className="brand-mark">T</div>
          <div>
            <div className="brand-title">Telegram Web</div>
            <div className="brand-subtitle">через GREEN-API</div>
          </div>
        </div>

        <div className="auth-copy">
          <h1>Подключить Telegram</h1>
          <p>
            Введите idInstance и apiTokenInstance вашего Telegram-инстанса из
            личного кабинета GREEN-API.
          </p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>idInstance</span>
            <input
              value={idInstance}
              onChange={(event) =>
                setIdInstance(event.target.value.replace(/\D/g, ""))
              }
              placeholder="4100000000"
              inputMode="numeric"
              autoComplete="username"
              spellCheck="false"
            />
          </label>

          <label className="field">
            <span>apiTokenInstance</span>
            <div className="token-input">
              <input
                type={showToken ? "text" : "password"}
                value={apiTokenInstance}
                onChange={(event) => setApiTokenInstance(event.target.value)}
                placeholder="••••••••••••••••"
                autoComplete="current-password"
                spellCheck="false"
              />
              {/* Глазик — показать/скрыть токен */}
              <button
                className="icon-button"
                type="button"
                onClick={() => setShowToken((value) => !value)}
                aria-label={showToken ? "Скрыть токен" : "Показать токен"}
                title={showToken ? "Скрыть токен" : "Показать токен"}
              >
                {showToken ? "◉" : "○"}
              </button>
            </div>
          </label>

          {/* Свой API URL нужен редко — только если инстанс на нестандартном поддомене.
              По умолчанию адрес вычисляется автоматически из idInstance. */}
          <details className="advanced">
            <summary>Дополнительно: свой API URL</summary>
            <label className="field">
              <span>API URL (необязательно)</span>
              <input
                value={apiUrl}
                onChange={(event) => setApiUrl(event.target.value)}
                placeholder="Подставится автоматически: https://XXXX.api.green-api.com"
                autoComplete="url"
                spellCheck="false"
              />
            </label>
          </details>

          {error && <div className="form-error">{error}</div>}

          <label className="check-row">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>Запомнить данные на этом устройстве</span>
          </label>

          <button className="primary-button auth-submit" type="submit">
            Войти в Telegram
          </button>
        </form>

        <div className="auth-note">
          <strong>Важно:</strong> Telegram GREEN-API использует путь{" "}
          <code>/waInstance...</code>. Запросы из браузера проходят через
          локальный dev-прокси Vite, поэтому токен не отправляется напрямую из
          браузера на внешний API-хост. Клиент работает с текстовыми
          сообщениями.
        </div>
      </section>
    </main>
  );
}
