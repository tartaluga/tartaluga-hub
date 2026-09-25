/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// CSP и прочие заголовки безопасности ставит Cloudflare (public/_headers), а не <meta>.

/**
 * Номер сборки (ADR-011 §1): sha коммита. В Cloudflare Workers Builds — WORKERS_CI_COMMIT_SHA,
 * локально — git rev-parse HEAD, без git — 'dev'.
 */
function buildId(): string {
  const ok = (v: string | undefined) => (v && /^[0-9a-f]{7,64}$/.test(v) ? v : undefined)
  const fromCi = ok(process.env.WORKERS_CI_COMMIT_SHA)
  if (fromCi) return fromCi
  try {
    return ok(execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) ?? 'dev'
  } catch {
    return 'dev'
  }
}

const BUILD_ID = buildId()

/** /build.json — номер сборки для Worker того же деплоя (worker/build.ts). В кэш service worker не попадает (нет json в globPatterns). */
function buildJson(): Plugin {
  return {
    name: 'hub-build-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build: BUILD_ID }) })
    },
  }
}

export default defineConfig({
  base: '/',
  define: {
    'import.meta.env.VITE_HUB_BUILD': JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    buildJson(),
    VitePWA({
      // Обновление принудительное (ADR-011), но включает его хаб, а не сам service worker:
      // 'prompt' значит «новая версия ждёт команды SKIP_WAITING». Хаб отдаёт её сразу, как только записал
      // handoff с черновиками (src/lib/update.ts). 'autoUpdate' перезагрузил бы страницу без handoff,
      // а старый код под новым service worker не нашёл бы свои ленивые чанки.
      registerType: 'prompt',
      // Регистрацию делает src/lib/update.ts (virtual:pwa-register), отдельный registerSW.js не нужен.
      injectRegister: false,
      includeAssets: ['favicon.svg'],
      manifest: {
        id: '/',
        name: 'Тарталуга Хаб',
        short_name: 'Тарталуга',
        description: 'Личный хаб проектов',
        lang: 'ru',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#161826',
        theme_color: '#161826',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2,png,webp}'],
        navigateFallback: 'index.html',
        // Вход через GitHub — это переход на /api/auth/...; service worker не должен подменять его на index.html.
        navigateFallbackDenylist: [/^\/api\//],
        // Запросы к API service worker не кэширует никогда: данные — только через IndexedDB (ADR-004, ADR-007).
        runtimeCaching: [],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'worker/**/*.test.ts'],
  },
})
