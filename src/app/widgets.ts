// Живые виджеты на клиенте (ADR-015): status.json с сервера (GET /api/status), проверка схемой, кэш на
// устройстве для офлайна и кнопка «Обновить сейчас» (POST /api/status/refresh + опрос, пока не сменится generatedAt).
//
// Пишет одна вкладка (ADR-013): «Обновить сейчас» доступна и во вкладке просмотра. Это не правка данных:
// очередь, кэш веток и репо данных не трогаются, сервер только просит GitHub запустить status.yml, а лишние
// запуски гасит группа concurrency. Кэш status.json на устройство пишет только пишущая вкладка — вкладка
// просмотра на устройство ничего не пишет.
import { create } from 'zustand'
import { api, ApiError, isNetworkError } from '../lib/api'
import { getCachedStatus, putCachedStatus } from '../lib/localdb'
import { lastCommits, parseStatus } from '../data/widgets'
import type { Status } from '../schema/types'

/** Не чаще раза в 5 минут при возврате на вкладку и появлении сети; старт и «Обновить сейчас» — всегда. */
export const RELOAD_MIN_MS = 5 * 60 * 1000
export const POLL_EVERY_MS = 15_000
export const POLL_LIMIT_MS = 3 * 60 * 1000

export const POLL_GAVE_UP = 'Не дождался новых данных — попробуй позже.'

export interface WidgetsState {
  /** Последний проверенный схемой status.json (с сервера или с устройства). */
  status: Status | null
  /** slug → время последнего коммита: для «заброшен». Пересчитывается только при смене status. */
  commits: ReadonlyMap<string, number>
  /** Виджеты ещё не собирались: status.json в ветке status нет (404 not_found). Это не ошибка. */
  empty: boolean
  /** status.json пришёл, но не прошёл проверку — показываем прежние данные и эту причину. */
  problem: string | null
  /** Идёт «Обновить сейчас»: кнопка заблокирована. */
  polling: boolean
  /** Итог «Обновить сейчас», если он не тихий: ошибка запуска или «не дождался». */
  refreshNote: string | null
}

const EMPTY: WidgetsState = { status: null, commits: new Map(), empty: false, problem: null, polling: false, refreshNote: null }

export const useWidgets = create<WidgetsState>(() => ({ ...EMPTY }))

interface Deps {
  /** Можно ли писать на устройство (вкладка пишущая). */
  canWrite: () => boolean
  now: () => number
}

let deps: Deps = { canWrite: () => true, now: () => Date.now() }
/** Поколение: после сброса (выход) запоздавшие ответы не пишутся ни в память, ни на устройство. */
let generation = 0
let lastLoad = 0
/** Сервер уже ответил в этом поколении — данные с устройства больше не нужны. */
let answered = false
let inflight: Promise<void> | null = null

function setStatus(status: Status | null, extra: Partial<WidgetsState> = {}) {
  useWidgets.setState({ status, commits: lastCommits(status), problem: null, empty: status === null, ...extra })
}

type Fetched = { kind: 'ok'; text: string; status: Status } | { kind: 'empty' } | { kind: 'invalid'; error: string }

async function fetchStatus(): Promise<Fetched> {
  try {
    const { text } = await api<{ sha: string; text: string }>('/api/status')
    if (typeof text !== 'string') return { kind: 'invalid', error: 'Сервер прислал status.json без текста' }
    const parsed = parseStatus(text)
    return parsed.ok ? { kind: 'ok', text, status: parsed.status } : { kind: 'invalid', error: parsed.error }
  } catch (e) {
    // «Ещё не собирались» — только подтверждённый сервером not_found (ADR-014); прочие 404 и 503 — временно.
    if (e instanceof ApiError && e.status === 404 && e.code === 'not_found') return { kind: 'empty' }
    throw e
  }
}

async function apply(got: Fetched, gen: number): Promise<void> {
  if (gen !== generation) return
  if (got.kind === 'invalid') {
    useWidgets.setState({ problem: got.error })
    return
  }
  answered = true
  if (got.kind === 'empty') setStatus(null)
  else setStatus(got.status, { empty: false })
  if (!deps.canWrite()) return
  try {
    await putCachedStatus(got.kind === 'ok' ? { text: got.text, loadedAt: deps.now() } : null)
  } catch {
    /* кэш — удобство для офлайна; без него виджеты просто появятся после сети */
  }
}

/** Поднять виджеты с устройства: сразу, до ответа сервера и без сети. */
export async function hydrateWidgets(): Promise<void> {
  const gen = generation
  let cached
  try {
    cached = await getCachedStatus()
  } catch {
    return
  }
  // Сервер успел ответить раньше устройства — его данные свежее.
  if (!cached || gen !== generation || answered) return
  const parsed = parseStatus(cached.text)
  if (parsed.ok && useWidgets.getState().status === null) setStatus(parsed.status, { empty: false })
}

/** Загрузить status.json. Без force — не чаще RELOAD_MIN_MS. Ошибка сети и 5xx — остаются прежние данные. */
export function loadWidgets(force = false): Promise<void> {
  if (inflight) return inflight
  const now = deps.now()
  if (!force && lastLoad > 0 && now - lastLoad < RELOAD_MIN_MS) return Promise.resolve()
  lastLoad = now
  const gen = generation
  inflight = fetchStatus()
    .then((got) => apply(got, gen))
    .catch(() => {
      /* нет сети или GitHub не ответил: показываем, что есть; следующая попытка — по триггеру */
    })
    .finally(() => {
      if (gen === generation) inflight = null
    })
  return inflight
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function refreshError(e: unknown): string {
  if (isNetworkError(e)) return 'Нет связи с сервером хаба — обновить не получилось.'
  if (e instanceof ApiError) return e.message
  return 'Что-то пошло не так. Попробуй ещё раз.'
}

/**
 * «Обновить сейчас»: запустить Action и опрашивать status.json каждые 15 с до 3 минут, пока не сменится
 * generatedAt. Итог: тихое обновление или refreshNote. Повторное нажатие во время опроса ничего не делает.
 */
export async function refreshWidgets(): Promise<void> {
  if (useWidgets.getState().polling) return
  const gen = generation
  const before = useWidgets.getState().status?.generatedAt ?? null
  useWidgets.setState({ polling: true, refreshNote: null })
  const finish = (refreshNote: string | null) => {
    if (gen === generation) useWidgets.setState({ polling: false, refreshNote })
  }
  try {
    await api<{ ok: true }>('/api/status/refresh', { method: 'POST' })
  } catch (e) {
    finish(refreshError(e))
    return
  }
  for (let waited = 0; waited < POLL_LIMIT_MS; waited += POLL_EVERY_MS) {
    await sleep(POLL_EVERY_MS)
    if (gen !== generation) return
    try {
      const got = await fetchStatus()
      if (got.kind === 'ok' && got.status.generatedAt !== before) {
        lastLoad = deps.now()
        await apply(got, gen)
        finish(null)
        return
      }
      if (got.kind === 'invalid') await apply(got, gen)
    } catch {
      /* временный сбой одного опроса — ждём следующий */
    }
  }
  finish(POLL_GAVE_UP)
}

export function dismissRefreshNote(): void {
  useWidgets.setState({ refreshNote: null })
}

/** Сброс памяти (выход, тесты): запоздавшие ответы и опрос больше ничего не меняют. */
export function resetWidgets(): void {
  generation++
  lastLoad = 0
  answered = false
  inflight = null
  useWidgets.setState({ ...EMPTY, commits: new Map() })
}

/**
 * Вошли: виджеты с устройства, затем с сервера; дальше — при возврате на вкладку и появлении сети
 * (не чаще RELOAD_MIN_MS). Возвращает отписку, которая и сбрасывает память.
 */
export function installWidgets(
  options: Partial<Deps> = {},
  win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
  doc: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { visibilityState: string } = document,
): () => void {
  deps = { canWrite: () => true, now: () => Date.now(), ...options }
  const onVisible = () => {
    if (doc.visibilityState === 'visible') void loadWidgets()
  }
  const onOnline = () => void loadWidgets()
  doc.addEventListener('visibilitychange', onVisible)
  win.addEventListener('online', onOnline)
  void hydrateWidgets()
  void loadWidgets(true)
  return () => {
    doc.removeEventListener('visibilitychange', onVisible)
    win.removeEventListener('online', onOnline)
    resetWidgets()
  }
}
