-- Хранилище сервера хаба (ADR-007). Применяется вручную, после одобрения владельца.

-- Сессии. Храним только SHA-256 от id сессии: утечка базы не даёт войти.
CREATE TABLE sessions (
  id_hash      TEXT PRIMARY KEY,           -- hex SHA-256 от случайного 256-битного id
  created_at   INTEGER NOT NULL,           -- мс с 1970; от него считается предел 90 дней
  expires_at   INTEGER NOT NULL,           -- скользящий срок 30 дней, не позже created_at + 90 дней
  last_used_at INTEGER NOT NULL,
  auth_at      INTEGER NOT NULL,           -- время последнего подтверждения личности («свежий вход» = 5 минут)
  auth_method  TEXT    NOT NULL CHECK (auth_method IN ('github', 'passkey')),
  device       TEXT    NOT NULL DEFAULT '' -- только браузер и ОС из User-Agent
) STRICT;
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Ключи доступа (passkeys).
CREATE TABLE passkeys (
  id           TEXT PRIMARY KEY,           -- credential id, base64url
  public_key   BLOB    NOT NULL,
  counter      INTEGER NOT NULL DEFAULT 0, -- 0 у синхронизируемых ключей — норма
  transports   TEXT    NOT NULL DEFAULT '[]',
  name         TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

-- Журнал безопасности: входы и изменения ключей. Хранится 180 дней, IP не пишем.
CREATE TABLE security_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  event   TEXT    NOT NULL,                -- login, login_denied, logout, logout_all, passkey_added, ...
  method  TEXT    NOT NULL DEFAULT '',
  device  TEXT    NOT NULL DEFAULT '',
  detail  TEXT    NOT NULL DEFAULT '',
  seen    INTEGER NOT NULL DEFAULT 0       -- 1, когда владелец увидел плашку о событии
) STRICT;
CREATE INDEX security_log_at ON security_log (at);
