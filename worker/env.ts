/** Привязки и настройки Worker (wrangler.jsonc). Секреты задаются в панели Cloudflare. */
export interface Env {
  ASSETS: Fetcher
  DB: D1Database

  APP_ORIGIN: string // https://hub.tartaluga.workers.dev — точный адрес для Origin, redirect_uri и rpId
  GITHUB_APP_ID: string
  GITHUB_APP_CLIENT_ID: string
  GITHUB_INSTALLATION_ID: string
  OWNER_GITHUB_ID: string // числовой id владельца на GitHub: только он может войти
  DATA_OWNER: string
  DATA_REPO: string

  // Секреты
  GITHUB_APP_PRIVATE_KEY: string // .pem приложения (PKCS#1 или PKCS#8)
  GITHUB_APP_CLIENT_SECRET: string
  COOKIE_SECRET: string // случайные 32+ байта: подпись временных cookie входа
}
