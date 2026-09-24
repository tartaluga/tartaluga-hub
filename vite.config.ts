/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// CSP и прочие заголовки безопасности ставит Cloudflare (public/_headers), а не <meta>.

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    VitePWA({
      // Новая версия не подменяется молча: пользователь сам жмёт «Обновить» (ADR-006).
      registerType: 'prompt',
      // Регистрацию делает UpdateBanner (virtual:pwa-register/react), отдельный registerSW.js не нужен.
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
