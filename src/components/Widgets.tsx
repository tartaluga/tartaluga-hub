// Живые виджеты (ADR-005, ADR-015): строка на плитке, раздел «Живое» в карточке проекта и общая плашка.
// Всё из status.json — недоверенный ввод: ссылки только через statusHref (http/https), тексты — только текстом.
import { useEffect, useState, type ReactNode } from 'react'
import { ArrowsClockwise, GitCommit, Globe, PlayCircle, RocketLaunch, Warning } from '@phosphor-icons/react'
import { dismissRefreshNote, refreshWidgets, useWidgets } from '../app/widgets'
import {
  ago,
  commitTitle,
  deployTarget,
  deployView,
  LATENCY_TEXT,
  projectErrors,
  projectStatus,
  runView,
  shortSha,
  siteView,
  staleHours,
  statusHref,
  TOKEN_SETTINGS_URL,
  tokenErrorText,
  tokenErrors,
  type Tone,
} from '../data/widgets'
import { useOnline } from '../lib/online'
import type { Site, StatusError } from '../schema/types'
import css from './Widgets.module.css'

const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer' } as const

/** «Сейчас» с тиком раз в минуту: подписи «N мин назад» не застывают. */
function useNowMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

/** Ссылка, если адрес прошёл фильтр; иначе просто текст. */
function Ext({ url, children, className }: { url: string | null | undefined; children: ReactNode; className?: string }) {
  const href = statusHref(url)
  return href ? (
    <a href={href} {...EXTERNAL} className={className}>
      {children}
    </a>
  ) : (
    <span className={className}>{children}</span>
  )
}

const Dot = ({ tone }: { tone: Tone }) => <span className={css.dot} data-tone={tone} aria-hidden />

// ---------- Плитка ----------

/** Компактно на плитке: точка сайта и «коммит N ч назад». Нет данных — ничего. */
export function TileWidgets({ slug }: { slug: string }) {
  const status = useWidgets((s) => s.status)
  const now = useNowMinute()
  const ps = projectStatus(status, slug)
  const commit = ps?.repo?.commits?.[0]
  if (!ps?.site && !commit) return null
  const site = ps.site ? siteView(ps.site) : null
  return (
    <p className={css.tile}>
      {site && (
        <span className={css.tileSite} title={`Сайт: ${site.text}`} data-tone={site.tone}>
          <Dot tone={site.tone} />
          <span>{site.tone === 'ok' ? 'сайт' : `сайт ${site.text}`}</span>
        </span>
      )}
      {commit && <span className={css.tileCommit}>коммит {ago(commit.date, now)}</span>}
    </p>
  )
}

// ---------- Кнопка ----------

export function RefreshButton({ compact = false }: { compact?: boolean }) {
  const polling = useWidgets((s) => s.polling)
  const online = useOnline()
  const label = polling ? 'Жду данные…' : 'Обновить сейчас'
  return (
    <button
      type="button"
      className={css.refresh}
      data-compact={compact || undefined}
      onClick={() => void refreshWidgets()}
      disabled={polling || !online}
      aria-busy={polling || undefined}
      title={online ? 'Запустить проверку виджетов на GitHub' : 'Нет сети — обновить нельзя'}
    >
      <ArrowsClockwise size={16} aria-hidden className={polling ? css.spin : undefined} />
      {label}
    </button>
  )
}

// ---------- Общая плашка ----------

/**
 * Что сказать про виджеты в целом: не обновлялись дольше 8 ч, ошибка токена статуса, status.json не прошёл
 * проверку, итог «Обновить сейчас». Нечего сказать — ничего.
 */
export function WidgetsNotice({ withButton = true }: { withButton?: boolean }) {
  const status = useWidgets((s) => s.status)
  const problem = useWidgets((s) => s.problem)
  const refreshNote = useWidgets((s) => s.refreshNote)
  const now = useNowMinute()
  const stale = staleHours(status, now)
  const token = tokenErrors(status)
  if (stale === null && token.length === 0 && !problem && !refreshNote) return null
  return (
    <div className={css.notice} role="status">
      <Warning size={18} aria-hidden className={css.noticeIcon} />
      <div className={css.noticeText}>
        {stale !== null && <p>Виджеты не обновлялись {stale} ч.</p>}
        {token.map((e) => (
          <p key={e.code}>
            {tokenErrorText(e)}{' '}
            <a href={TOKEN_SETTINGS_URL} {...EXTERNAL}>
              Токены GitHub
            </a>
          </p>
        ))}
        {problem && <p>{problem}. Показаны прежние данные.</p>}
        {refreshNote && (
          <p>
            {refreshNote}{' '}
            <button type="button" className={css.linkButton} onClick={dismissRefreshNote}>
              Скрыть
            </button>
          </p>
        )}
      </div>
      {stale !== null && withButton && <RefreshButton compact />}
    </div>
  )
}

// ---------- Карточка ----------

function ErrorLine({ e }: { e: StatusError }) {
  if (e.code === 'repo_not_accessible') {
    return (
      <p className={css.error}>
        Добавь <span className="mono">{e.repo ?? 'репо'}</span> в токен статуса —{' '}
        <a href={TOKEN_SETTINGS_URL} {...EXTERNAL}>
          настройки токенов
        </a>
      </p>
    )
  }
  return <p className={css.error}>{e.message}</p>
}

/** Раздел «Живое» в карточке: сайт, деплой, Actions, последние коммиты и кнопка «Обновить сейчас». */
export function ProjectWidgets({ slug }: { slug: string }) {
  const status = useWidgets((s) => s.status)
  const empty = useWidgets((s) => s.empty)
  const now = useNowMinute()
  const ps = projectStatus(status, slug)
  const errors = projectErrors(status, slug)
  const repo = ps?.repo
  const commits = repo?.commits ?? []

  return (
    <section className={css.section} aria-labelledby={`live-${slug}`}>
      <div className={css.head}>
        <h2 id={`live-${slug}`} className={css.title}>
          Живое
        </h2>
        <RefreshButton compact />
      </div>
      {status?.generatedAt && <p className={css.meta}>проверено {ago(status.generatedAt, now)}</p>}
      <WidgetsNotice withButton={false} />
      {errors.map((e, i) => (
        <ErrorLine key={`${e.code}-${i}`} e={e} />
      ))}

      {!status ? (
        <p className={css.muted}>{empty ? 'Виджеты ещё не собирались — нажми «Обновить сейчас».' : 'Данных виджетов пока нет.'}</p>
      ) : !ps?.site && !repo ? (
        errors.length === 0 && <p className={css.muted}>Нечего проверять: добавь проекту ссылку «сайт» или «репо».</p>
      ) : (
        <ul className={css.rows}>
          {ps.site && <SiteRow site={ps.site} />}
          {repo?.deployment && (
            <li className={css.row}>
              <RocketLaunch size={18} className={css.icon} aria-hidden />
              <span className={css.rowMain}>
                <Ext url={repo.deployment.url}>{deployTarget(repo.deployment)}</Ext>
                <span className={css.state} data-tone={deployView(repo.deployment).tone}>
                  <Dot tone={deployView(repo.deployment).tone} />
                  {deployView(repo.deployment).text}
                </span>
              </span>
              <span className={css.when}>{ago(repo.deployment.at, now)}</span>
            </li>
          )}
          {repo?.lastRun && (
            <li className={css.row}>
              <PlayCircle size={18} className={css.icon} aria-hidden />
              <span className={css.rowMain}>
                <Ext url={repo.lastRun.url}>{repo.lastRun.name || 'Actions'}</Ext>
                <span className={css.state} data-tone={runView(repo.lastRun).tone}>
                  <Dot tone={runView(repo.lastRun).tone} />
                  {runView(repo.lastRun).text}
                </span>
              </span>
              <span className={css.when}>{ago(repo.lastRun.at, now)}</span>
            </li>
          )}
          {commits.length > 0 && (
            <li className={css.commitsRow}>
              <div className={css.commitsHead}>
                <GitCommit size={18} className={css.icon} aria-hidden />
                <span>
                  Коммиты
                  {repo?.defaultBranch && <span className={css.branch}> · {repo.defaultBranch}</span>}
                </span>
              </div>
              <ol className={css.commits}>
                {commits.slice(0, 5).map((c, i) => (
                  <li key={`${c.sha}-${i}`} className={css.commit}>
                    <Ext url={c.url} className={css.sha}>
                      {shortSha(c.sha) || '•'}
                    </Ext>
                    <span className={css.message} title={c.message}>
                      {commitTitle(c.message)}
                    </span>
                    <span className={css.when}>{ago(c.date, now)}</span>
                  </li>
                ))}
              </ol>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

function SiteRow({ site }: { site: Site }) {
  const view = siteView(site)
  const host = hostOf(site.url)
  const details = [site.httpStatus != null ? String(site.httpStatus) : null, site.latency ? LATENCY_TEXT[site.latency] : null].filter(Boolean).join(' · ')
  return (
    <li className={css.row}>
      <Globe size={18} className={css.icon} aria-hidden />
      <span className={css.rowMain}>
        <Ext url={site.url}>{host}</Ext>
        <span className={css.state} data-tone={view.tone}>
          <Dot tone={view.tone} />
          {view.text}
        </span>
      </span>
      {details && <span className={css.when}>{details}</span>}
    </li>
  )
}

/** Хост для подписи; не адрес — как есть (текстом). */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
