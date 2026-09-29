// Живые виджеты (ADR-005, ADR-015): разбор status.json и подписи для плитки и карточки. Чистые функции:
// «сейчас» всегда приходит параметром. status.json пишет Action, но ссылки и тексты в нём — из чужих репо и
// сайтов, поэтому это недоверенный ввод: файл проверяется схемой, ссылки — тем же фильтром, что ссылки проектов,
// тексты показываются только как текст.
import type { ProjectStatus, Repo, Site, Status, StatusError } from '../schema/types'
import { validateStatus } from '../schema/validators.js'
import { webUrl } from './editProject'
import { describeErrors } from './model'

export type ParsedStatus = { ok: true; status: Status } | { ok: false; error: string }

/** Старше — «виджеты не обновлялись N ч» (ADR-015 п.3: пульс раз в 6 ч, запас 2 ч). */
export const STALE_AFTER_H = 8
/** Страница fine-grained токенов: туда добавляют репо в токен статуса. */
export const TOKEN_SETTINGS_URL = 'https://github.com/settings/personal-access-tokens'

const HOUR = 60 * 60 * 1000

export function parseStatus(text: string): ParsedStatus {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'status.json — не JSON' }
  }
  if (!validateStatus(data)) return { ok: false, error: `status.json не прошёл проверку: ${describeErrors(validateStatus.errors)}` }
  return { ok: true, status: data as Status }
}

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? null : t
}

/** Статус проекта по slug. Только собственные ключи: slug «__proto__» или «constructor» не достанет чужого. */
export function projectStatus(status: Status | null, slug: string): ProjectStatus | null {
  if (!status || !Object.prototype.hasOwnProperty.call(status.projects, slug)) return null
  return status.projects[slug] ?? null
}

/** Время самого свежего коммита репо проекта (мс) или null. */
export function lastCommitAt(repo: Repo | undefined): number | null {
  let best: number | null = null
  for (const c of repo?.commits ?? []) {
    const t = time(c.date)
    if (t !== null && (best === null || t > best)) best = t
  }
  return best
}

/** slug → время последнего коммита: для «заброшен» (ADR-015 п.7). */
export function lastCommits(status: Status | null): Map<string, number> {
  const out = new Map<string, number>()
  if (!status) return out
  for (const slug of Object.keys(status.projects)) {
    const t = lastCommitAt(status.projects[slug]?.repo)
    if (t !== null) out.set(slug, t)
  }
  return out
}

/** Сколько целых часов виджеты не обновлялись, если дольше порога; иначе null. */
export function staleHours(status: Status | null, now: number): number | null {
  const at = time(status?.generatedAt)
  if (at === null) return null
  const hours = Math.floor((now - at) / HOUR)
  return hours >= STALE_AFTER_H ? hours : null
}

/** «только что», «12 мин назад», «3 ч назад», «5 дн назад». Время из будущего — «только что». */
export function ago(iso: string | null | undefined, now: number): string {
  const t = time(iso)
  if (t === null) return ''
  const min = Math.floor((now - t) / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч назад`
  return `${Math.floor(h / 24)} дн назад`
}

export type Tone = 'ok' | 'bad' | 'warn' | 'muted'

/** Сайт: blocked — «не проверить» (антибот режет датацентр раннера), а не «упал». */
export function siteView(site: Pick<Site, 'state'>): { tone: Tone; text: string } {
  if (site.state === 'up') return { tone: 'ok', text: 'работает' }
  if (site.state === 'down') return { tone: 'bad', text: 'не отвечает' }
  return { tone: 'muted', text: 'не проверить' }
}

export const LATENCY_TEXT: Record<string, string> = { fast: '< 300 мс', ok: '< 1 с', slow: 'медленно' }

type Run = NonNullable<Repo['lastRun']>
type Deployment = NonNullable<Repo['deployment']>

const WAITING = new Set(['queued', 'waiting', 'pending', 'requested'])

/** Последний запуск Actions: итог словом и тон. */
export function runView(run: Run): { tone: Tone; text: string } {
  if (run.status && run.status !== 'completed') return { tone: 'warn', text: WAITING.has(run.status) ? 'в очереди' : 'идёт' }
  switch (run.conclusion) {
    case 'success':
      return { tone: 'ok', text: 'успешно' }
    case 'failure':
    case 'startup_failure':
      return { tone: 'bad', text: 'упал' }
    case 'timed_out':
      return { tone: 'bad', text: 'таймаут' }
    case 'cancelled':
      return { tone: 'muted', text: 'отменён' }
    case 'skipped':
      return { tone: 'muted', text: 'пропущен' }
    default:
      return { tone: 'muted', text: run.conclusion ?? run.status ?? '—' }
  }
}

const PROVIDERS: [RegExp, string][] = [
  [/^netlify(\[bot\])?$/i, 'Netlify'],
  [/^vercel(\[bot\])?$/i, 'Vercel'],
  [/^cloudflare[a-z-]*(\[bot\])?$/i, 'Cloudflare'],
  [/^github-pages(\[bot\])?$/i, 'GitHub Pages'],
  [/^render(\[bot\])?$/i, 'Render'],
  [/^railway(-app)?(\[bot\])?$/i, 'Railway'],
]

/** Куда деплой: известный бот → провайдер, иначе environment. */
export function deployTarget(dep: Deployment): string {
  const creator = dep.creator ?? ''
  for (const [re, name] of PROVIDERS) if (re.test(creator)) return name
  return dep.environment || 'деплой'
}

export function deployView(dep: Deployment): { tone: Tone; text: string } {
  switch (dep.state) {
    case 'success':
    case 'active':
      return { tone: 'ok', text: 'выложен' }
    case 'failure':
    case 'error':
      return { tone: 'bad', text: 'ошибка' }
    case 'in_progress':
    case 'queued':
    case 'pending':
      return { tone: 'warn', text: 'идёт' }
    case 'inactive':
      return { tone: 'muted', text: 'заменён' }
    default:
      return { tone: 'muted', text: dep.state ?? '—' }
  }
}

/** Первая строка сообщения коммита. */
export const commitTitle = (message: string) => message.split(/\r?\n/, 1)[0]!.trim()

/** Короткий sha для подписи: только шестнадцатеричные символы, не больше 7. */
export const shortSha = (sha: string) => (/^[0-9a-f]+$/i.test(sha) ? sha.slice(0, 7) : '')

/** Ссылка из status.json: только http(s), иначе null — показывается текстом (ADR-015 п.5). */
export const statusHref = (url: string | null | undefined): string | null => (url ? webUrl(url) : null)

export const TOKEN_CODES = new Set(['token_expired', 'token_missing'])

/** Общие ошибки токена статуса — одна плашка на все виджеты. */
export const tokenErrors = (status: Status | null): StatusError[] => (status?.errors ?? []).filter((e) => TOKEN_CODES.has(e.code))

/** Ошибки конкретного проекта (кроме общих ошибок токена). */
export const projectErrors = (status: Status | null, slug: string): StatusError[] =>
  (status?.errors ?? []).filter((e) => e.project === slug && !TOKEN_CODES.has(e.code))

/** Текст общей плашки для ошибки токена. */
export function tokenErrorText(e: Pick<StatusError, 'code'>): string {
  if (e.code === 'token_expired') return 'Токен статуса истёк — приватные репо не читаются. Выпусти новый и обнови секрет STATUS_READ_TOKEN в репо данных.'
  return 'Токена статуса нет — приватные репо не читаются. Создай его и положи в секрет STATUS_READ_TOKEN репо данных.'
}
