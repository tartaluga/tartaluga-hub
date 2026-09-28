// «Скачать неотправленное» (ADR-004): если синхронизация невозможна, правки с устройства можно сохранить руками.
// Файл собирается из явного списка полей: в него попадают только данные проектов — ни сессии, ни служебных id.
import type { QueuedEdit, StoredConflict } from '../lib/localdb'

export const UNSENT_FORMAT = 'tartaluga-hub-unsent'

export interface UnsentEdit {
  branch: string
  path: string
  queuedAt: string
  /** sha версии файла в репо, к которой применена правка. */
  baseSha: string
  /** Моя версия файла целиком: разобранный JSON, а если не разбирается — текст как есть. */
  content: unknown
  /** Что именно поменяно относительно базовой версии. */
  patch: unknown
}

export interface UnsentConflictPlace {
  label: string
  path: (string | number)[]
  /** Было в общей версии. */
  base: unknown
  /** Моя версия места. */
  mine: unknown
  /** Версия места из репо. */
  theirs: unknown
}

export interface UnsentConflict {
  branch: string
  path: string
  title: string
  at: string
  places: UnsentConflictPlace[]
  /** Правку не удалось ни слить, ни записать: причина и моя версия файла целиком. */
  refused?: { reason: string; content: unknown }
  /** Файл удалили в репо, а у меня была правка: моя версия файла. */
  deleted?: { content: unknown }
}

export interface UnsentExport {
  format: typeof UNSENT_FORMAT
  formatVersion: 1
  exportedAt: string
  note: string
  edits: UnsentEdit[]
  conflicts: UnsentConflict[]
}

const NOTE =
  'Правки, которые хаб не отправил в репо данных. edits — ожидающие правки: content — моя версия файла целиком. ' +
  'conflicts — входящие конфликты: mine — моя версия места, theirs — версия из репо. Чтобы сохранить руками, перенеси content в файл path ветки branch.'

/** Текст файла как JSON, если он разбирается; иначе — сам текст, чтобы ничего не потерять. */
function content(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** undefined в JSON пропадает; «места нет» записываем как null. */
const orNull = (v: unknown) => (v === undefined ? null : v)

const byPlace = (a: { branch: string; path: string }, b: { branch: string; path: string }) =>
  a.branch.localeCompare(b.branch) || a.path.localeCompare(b.path)

export function buildUnsentExport(edits: QueuedEdit[], conflicts: StoredConflict[], now = new Date()): UnsentExport {
  return {
    format: UNSENT_FORMAT,
    formatVersion: 1,
    exportedAt: now.toISOString(),
    note: NOTE,
    edits: [...edits].sort(byPlace).map((e) => ({
      branch: e.branch,
      path: e.path,
      queuedAt: e.queuedAt,
      baseSha: e.baseSha,
      content: content(e.text),
      patch: e.patch,
    })),
    conflicts: [...conflicts].sort(byPlace).map((c) => {
      const out: UnsentConflict = {
        branch: c.branch,
        path: c.path,
        title: c.title,
        at: c.at,
        places: c.items.map((item, i) => ({
          label: c.labels[i] ?? '',
          path: [...item.path],
          base: orNull(item.base),
          mine: orNull(item.local),
          theirs: orNull(item.remote),
        })),
      }
      if (c.refused) out.refused = { reason: c.refused.reason, content: content(c.refused.mine) }
      if (c.deleted) out.deleted = { content: content(c.deleted.mine) }
      return out
    }),
  }
}

/** Есть ли что выгружать. */
export const hasUnsent = (x: { edits: unknown[]; conflicts: unknown[] }) => x.edits.length > 0 || x.conflicts.length > 0

/** Имя файла: hub-unsent-2026-09-26-1430.json (местное время). */
export function unsentFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `hub-unsent-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`
}

/** Скачать JSON через Blob и временную ссылку <a download>. */
export function downloadJson(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  // Отозвать сразу нельзя: часть браузеров начинает загрузку после click асинхронно.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
