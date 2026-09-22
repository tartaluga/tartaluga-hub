/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Строгая CSP только в сборке: dev-сервер Vite вставляет inline-скрипты для HMR.
// Разрешены только свои файлы и api.github.com (ADR-001).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // 'unsafe-inline' для стилей нужен Motion: он анимирует через атрибут style.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self' https://api.github.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

function cspMeta(): Plugin {
  return {
    name: 'tartaluga-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    ],
  }
}

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    cspMeta(),
    VitePWA({
      // Новая версия не подменяется молча: пользователь сам жмёт «Обновить» (ADR-006).
      registerType: 'prompt',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Tartaluga Hub',
        short_name: 'Tartaluga',
        description: 'Личный хаб проектов',
        lang: 'ru',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#161826',
        theme_color: '#161826',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2,png,webp}'],
        navigateFallback: 'index.html',
        // Запросы к GitHub API service worker не кэширует никогда (ADR-002).
        runtimeCaching: [],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
