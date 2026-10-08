import { useEffect, useState } from "react";
import Login from "./components/Login.jsx";
import Chat from "./components/Chat.jsx";

// Ключ в хранилище. Версия .v4 — чтобы после смены структуры credentials
// старые сохранённые данные не подхватывались и не ломали вход.
const STORAGE_KEY = "greenApiCreds.v4";

// Проверяем, что сохранённые данные выглядят вменяемо.
// Заодно отсеиваем старый формат, где apiUrl мог быть общим api.green-api.com.
function isValidSavedCredentials(credentials) {
  if (
    !credentials ||
    !credentials.idInstance ||
    !credentials.apiTokenInstance ||
    !credentials.apiUrl
  ) {
    return false;
  }

  try {
    const url = new URL(credentials.apiUrl);
    return !/^api\.green-api\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function readSavedCredentials() {
  try {
    const local = localStorage.getItem(STORAGE_KEY);
    if (local) {
      const credentials = JSON.parse(local);
      if (isValidSavedCredentials(credentials)) {
        return { credentials, remember: true };
      }
      localStorage.removeItem(STORAGE_KEY);
    }

    const session = sessionStorage.getItem(STORAGE_KEY);
    if (session) {
      const credentials = JSON.parse(session);
      if (isValidSavedCredentials(credentials)) {
        return { credentials, remember: false };
      }
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Если JSON битый или хранилище недоступно — просто чистим
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  }

  return { credentials: null, remember: false };
}

export default function App() {
  const [credentials, setCredentials] = useState(null);

  // Восстанавливаем сессию один раз при загрузке
  useEffect(() => {
    setCredentials(readSavedCredentials().credentials);
  }, []);

  const handleLogin = (nextCredentials, remember) => {
    const payload = JSON.stringify(nextCredentials);

    // Сначала чистим оба хранилища, потом пишем в нужное —
    // чтобы не осталось следов от предыдущего входа
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);

    if (remember) {
      localStorage.setItem(STORAGE_KEY, payload);
    } else {
      sessionStorage.setItem(STORAGE_KEY, payload);
    }

    setCredentials(nextCredentials);
  };

  const handleLogout = () => {
    setCredentials(null);
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  };

  return credentials ? (
    <Chat credentials={credentials} onLogout={handleLogout} />
  ) : (
    <Login onLogin={handleLogin} />
  );
}