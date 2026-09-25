// Принудительное обновление хаба (ADR-011). Плашки «Обновить» нет: новая версия включается сама,
// а незаконченное переезжает через handoff (drafts.ts). Логика — в createUpdater (чистая, тестируется),
// связка с service worker — в installUpdater (только браузер).

/** Номер сборки, вшитый vite.config.ts (sha коммита). Тот же номер Worker читает из /build.json. */
export const BUILD_ID: string = (() => {
  const v: unknown = import.meta.env.VITE_HUB_BUILD
  return typeof v === 'string' && v ? v : 'dev'
})()

export const BUILD_HEADER = 'X-Hub-Build'
export const STALE_BUILD = 'stale_build'

/** Защита от петли перезагрузок (ADR-011 §3): не больше 2 попыток за 5 минут. */
export const LOOP_WINDOW_MS = 5 * 60 * 1000
export const LOOP_MAX_ATTEMPTS = 2
const ATTEMPTS_KEY = 'tartaluga.update.attempts'
const CHECK_EVERY_MS = 60 * 60 * 1000
const INSTALL_TIMEOUT_MS = 30_000
const ACTIVATE_TIMEOUT_MS = 10_000

export type UpdateReason = 'startup' | 'new_version' | 'stale_build' | 'external' | 'retry'
/** idle — работаем; updating — идёт перезагрузка; deferred — обновиться сейчас нельзя, повторим позже. */
export type UpdateStatus = 'idle' | 'updating' | 'deferred'

export interface UpdatePlatform {
  /** Новая версия установлена и ждёт включения. */
  hasWaiting(): boolean
  /** Спросить сервер о новой версии и дождаться её установки. true — новая версия ждёт. */
  check(): Promise<boolean>
  /** Включить ждущую версию и перезагрузить страницу. */
  activate(): void
  reload(): void
}

export interface AttemptLog {
  read(): number[]
  write(list: number[]): void
}

export interface UpdaterDeps {
  platform: UpdatePlatform
  /** Записать handoff. Бросает — не перезагружаемся, чтобы не потерять черновики. */
  saveHandoff(): Promise<void>
  attempts: AttemptLog
  now(): number
  schedule(fn: () => void, ms: number): void
}

export interface Updater {
  /** Обновиться по причине; true — перезагрузка запущена. */
  run(reason: UpdateReason): Promise<boolean>
  status(): UpdateStatus
  subscribe(fn: () => void): () => void
}

export function createUpdater(deps: UpdaterDeps): Updater {
  let status: UpdateStatus = 'idle'
  let retryPending = false
  const listeners = new Set<() => void>()
  const current = (): UpdateStatus => status
  const setStatus = (s: UpdateStatus) => {
    if (s === status) return
    status = s
    for (const l of listeners) l()
  }

  const defer = (ms: number) => {
    setStatus('deferred')
    if (retryPending) return
    retryPending = true
    deps.schedule(() => {
      retryPending = false
      void run('retry')
    }, Math.max(1000, ms))
  }

  async function run(reason: UpdateReason): Promise<boolean> {
    if (status === 'updating') return false
    // Сервер сказал «сборка устарела», а service worker новую версию ещё не видит — спрашиваем сами.
    if ((reason === 'stale_build' || reason === 'retry') && !deps.platform.hasWaiting()) {
      try {
        await deps.platform.check()
      } catch {
        /* нет сети или SW — ниже просто перезагрузимся */
      }
    }
    // Проверку делали асинхронно — за это время обновление могло стартовать по событию SW.
    if (current() === 'updating') return false

    const now = deps.now()
    const recent = deps.attempts.read().filter((t) => t <= now && now - t < LOOP_WINDOW_MS)
    if (recent.length >= LOOP_MAX_ATTEMPTS) {
      defer(Math.min(...recent) + LOOP_WINDOW_MS - now)
      return false
    }
    setStatus('updating')
    deps.attempts.write([...recent, now])
    // При запуске на экране ещё ничего нет, а прежний handoff (если есть) должна прочитать новая версия.
    if (reason !== 'startup') {
      try {
        await deps.saveHandoff()
      } catch (e) {
        console.warn('handoff не записан, обновление отложено:', e instanceof Error ? e.message : e)
        defer(LOOP_WINDOW_MS)
        return false
      }
    }
    if (deps.platform.hasWaiting()) deps.platform.activate()
    else deps.platform.reload()
    return true
  }

  return {
    run,
    status: () => status,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

// ---------- Сигнал «сборка устарела» от api.ts ----------

let staleHandler: (() => void) | null = null

export function onStaleBuild(fn: (() => void) | null): void {
  staleHandler = fn
}

/** Сервер отказал в записи со stale_build — запустить обновление. */
export function reportStaleBuild(): void {
  staleHandler?.()
}

// ---------- Браузер ----------

export function localStorageAttempts(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): AttemptLog {
  return {
    read() {
      try {
        const v: unknown = JSON.parse(storage.getItem(ATTEMPTS_KEY) ?? '[]')
        return Array.isArray(v) ? v.filter((t): t is number => typeof t === 'number' && Number.isFinite(t)) : []
      } catch {
        return []
      }
    },
    write(list) {
      try {
        storage.setItem(ATTEMPTS_KEY, JSON.stringify(list))
      } catch {
        /* хранилище недоступно — защита от петли работает только в пределах вкладки */
      }
    },
  }
}

/** Дождаться, пока устанавливаемая версия встанет в ожидание. */
function waitInstalled(reg: ServiceWorkerRegistration, timeoutMs: number): Promise<boolean> {
  if (reg.waiting) return Promise.resolve(true)
  const sw = reg.installing
  if (!sw) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(Boolean(reg.waiting)), timeoutMs)
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' || sw.state === 'redundant') {
        clearTimeout(timer)
        resolve(Boolean(reg.waiting))
      }
    })
  })
}

type RegisterSW = (options: {
  immediate?: boolean
  onNeedRefresh?: () => void
  onNeedReload?: () => void
  onRegisteredSW?: (url: string, reg: ServiceWorkerRegistration | undefined) => void
}) => unknown

let active: Updater | null = null

/**
 * Подключить обновление к service worker. Вызывается один раз в main.tsx.
 * registerSW передаётся снаружи (virtual:pwa-register), чтобы модуль оставался тестируемым.
 */
export function installUpdater(registerSW: RegisterSW, saveHandoff: () => Promise<void>): { updater: Updater; applyWaitingAtStartup(): Promise<boolean> } {
  const sw = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined
  let reg: ServiceWorkerRegistration | undefined
  let activating = false
  // Страница уже под service worker: смена контроллера значит новую версию (например, её включила другая вкладка).
  const hadController = Boolean(sw?.controller)

  const platform: UpdatePlatform = {
    hasWaiting: () => Boolean(reg?.waiting),
    async check() {
      if (!reg) return false
      await reg.update()
      return waitInstalled(reg, INSTALL_TIMEOUT_MS)
    },
    activate() {
      const waiting = reg?.waiting
      if (!waiting || !sw) return location.reload()
      activating = true
      sw.addEventListener('controllerchange', () => location.reload(), { once: true })
      waiting.postMessage({ type: 'SKIP_WAITING' })
      // Новая версия не взяла управление — перезагружаемся всё равно, handoff уже записан.
      setTimeout(() => location.reload(), ACTIVATE_TIMEOUT_MS)
    },
    reload: () => location.reload(),
  }

  const updater = createUpdater({
    platform,
    saveHandoff,
    attempts: localStorageAttempts(),
    now: () => Date.now(),
    schedule: (fn, ms) => void setTimeout(fn, ms),
  })
  active = updater
  onStaleBuild(() => void updater.run('stale_build'))

  registerSW({
    immediate: true,
    onNeedRefresh: () => void updater.run('new_version'),
    // Перезагрузку делает хаб сам — после записи handoff.
    onNeedReload: () => {},
    onRegisteredSW(_url, r) {
      reg = r
      if (r) setInterval(() => void r.update().catch(() => {}), CHECK_EVERY_MS)
    },
  })

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void reg?.update().catch(() => {})
    })
  }
  sw?.addEventListener('controllerchange', () => {
    if (hadController && !activating) void updater.run('external')
  })

  return {
    updater,
    /** При открытии: новая версия уже скачана — включить её до первого экрана. true — идёт перезагрузка. */
    async applyWaitingAtStartup() {
      if (!sw?.controller) return false
      try {
        const r = await sw.getRegistration()
        if (!r?.waiting) return false
        reg ??= r
        return await updater.run('startup')
      } catch {
        return false
      }
    },
  }
}

export function getUpdateStatus(): UpdateStatus {
  return active?.status() ?? 'idle'
}

export function subscribeUpdateStatus(fn: () => void): () => void {
  return active ? active.subscribe(fn) : () => {}
}
