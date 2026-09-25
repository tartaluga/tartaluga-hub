// Функции миграции локального состояния устройства (ADR-011 §5): handoff, позже очередь правок и kv.
// Файлы данных в репо сюда не относятся — у них свой контракт (ADR-003, ADR-009).
//
// Правило: сборка, которая меняет формат черновиков, handoff, очереди или kv, повышает STATE_VERSION
// и дописывает в конец MIGRATIONS функцию v(n) → v(n+1). Старые функции не меняются и не удаляются.
// Тест в migrations.test.ts сверяет «отпечаток» формата с таблицей версий и не даст забыть миграцию.

/** Текущая версия формата локального состояния. */
export const STATE_VERSION = 1

/** Чистая функция: состояние версии n → состояние версии n + 1. Бросает, если привести нельзя. */
export type Migration = (state: unknown) => unknown

/** MIGRATIONS[i] переводит версию i + 1 в версию i + 2. Длина всегда STATE_VERSION − 1. */
export const MIGRATIONS: readonly Migration[] = []

export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

/** Прогнать состояние версии `from` через цепочку до версии `to`. Исходный объект не меняется (функции чистые). */
export function migrateState(state: unknown, from: unknown, to: number = STATE_VERSION, list: readonly Migration[] = MIGRATIONS): unknown {
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 1) throw new MigrationError(`Неизвестная версия состояния: ${String(from)}`)
  if (from > to) throw new MigrationError(`Состояние версии ${from} новее этой сборки (${to})`)
  let current = state
  for (let v = from; v < to; v++) {
    const step = list[v - 1]
    if (!step) throw new MigrationError(`Нет функции миграции ${v} → ${v + 1}`)
    try {
      current = step(current)
    } catch (e) {
      throw new MigrationError(`Миграция ${v} → ${v + 1} не удалась: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return current
}
