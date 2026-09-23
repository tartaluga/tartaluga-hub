# Tartaluga Hub

Личный хаб проектов: PWA, которая открывается на ПК, ноутбуке и телефоне. Живёт по адресу https://hub.tartaluga.workers.dev/ (Cloudflare Workers, ADR-007).

В этом репозитории только код приложения и сервера (`worker/`). Данных здесь нет: они лежат в отдельном приватном репозитории, сервер читает и пишет его через GitHub App. Вход — по ключу доступа или через GitHub, токенов в браузере нет.

- Архитектурные решения: [docs/adr](docs/adr/README.md)
- План и задачи: [tasks/plan.md](tasks/plan.md), [tasks/todo.md](tasks/todo.md)

## Разработка
```bash
npm ci
npm run dev        # локальный сервер
npm test           # тесты (Vitest)
npm run typecheck  # проверка типов
npm run build      # сборка в dist/
npm run worker:dev # сервер локально на 127.0.0.1:8787 (нужен .dev.vars с фиктивными секретами)
```
Push в `main` собирает, проверяет тестами и выкатывает хаб через Cloudflare Workers Builds.
