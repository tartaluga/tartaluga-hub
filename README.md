# Tartaluga Hub

Личный хаб проектов: PWA, которая открывается на ПК, ноутбуке и телефоне. Живёт по адресу https://tartaluga.github.io/.

В этом репозитории только код приложения. Данных здесь нет: они лежат в отдельном приватном репозитории, приложение читает его через GitHub API с токеном владельца.

- Архитектурные решения: [docs/adr](docs/adr/README.md)
- План и задачи: [tasks/plan.md](tasks/plan.md), [tasks/todo.md](tasks/todo.md)

## Разработка
```bash
npm ci
npm run dev        # локальный сервер
npm test           # тесты (Vitest)
npm run typecheck  # проверка типов
npm run build      # сборка в dist/
```
Push в `main` собирает и публикует сайт через GitHub Actions.
