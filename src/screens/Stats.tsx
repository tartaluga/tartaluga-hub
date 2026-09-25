// «Статистика» по макету 2c: итоги за месяц, квартал или полгода. Экран только читает файлы ветки.
// Коммиты требуют виджетов репо (ADR-005) — до них вместо чисел пустое состояние, а не выдумка.
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { MAIN, useSession } from '../app/session'
import { StatsHeatLegend, StatsHeatmap, StatsMeter, StatsStackBar } from '../components/StatsCharts'
import { parseLocalDate } from '../data/model'
import { buildLibrary, STATUS_LABEL } from '../data/projects'
import {
  activityByProject,
  deadlines,
  isPeriod,
  logCount,
  OUTCOME_LABEL,
  OUTCOMES,
  percentText,
  PERIOD_LABEL,
  PERIODS,
  periodRange,
  published,
  rangeLabel,
  shortDate,
  statsPulse,
  tasksClosed,
  type Period,
} from '../data/stats'
import { localKey, statusShares } from '../data/today'
import { plural } from '../lib/plural'
import css from './Stats.module.css'

const DEFAULT_PERIOD: Period = 'quarter'
// Как на «Сегодня»: остальное — в «Проектах», чтобы список не растягивал экран.
const ACTIVITY_LIMIT = 8

/** Местный день, обновляется раз в минуту: после полуночи период сдвигается сам. */
function useToday(): string {
  const [day, setDay] = useState(() => localKey(new Date()))
  useEffect(() => {
    const id = setInterval(() => setDay(localKey(new Date())), 60_000)
    return () => clearInterval(id)
  }, [])
  return day
}

export function Stats() {
  const files = useSession((s) => s.files)
  const branch = useSession((s) => s.branch)
  const day = useToday()
  const [params, setParams] = useSearchParams()
  const raw = params.get('period')
  const period: Period = isPeriod(raw) ? raw : DEFAULT_PERIOD

  const view = useMemo(() => {
    const today = parseLocalDate(day)
    const lib = buildLibrary(files, today)
    const range = periodRange(period, today)
    const ps = lib.projects
    return {
      lib,
      range,
      log: logCount(ps, range),
      closed: tasksClosed(ps, range),
      deadlines: deadlines(ps, range),
      pulse: statsPulse(ps, range),
      activity: activityByProject(ps, range),
      published: published(ps, range),
      shares: statusShares(ps),
    }
  }, [files, day, period])
  const { lib, range, deadlines: dl } = view
  const total = lib.projects.length

  const choose = (p: Period) => {
    const next = new URLSearchParams(params)
    if (p === DEFAULT_PERIOD) next.delete('period')
    else next.set('period', p)
    setParams(next, { replace: true })
  }

  return (
    <section className={css.page}>
      <header className={css.head}>
        <div>
          <div className="eyebrow">{rangeLabel(range)}</div>
          <h1 className={css.title}>Статистика</h1>
        </div>
        <div className={css.periods} role="group" aria-label="Период">
          {PERIODS.map((p) => (
            <button key={p} type="button" className={css.period} aria-pressed={p === period} onClick={() => choose(p)}>
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
      </header>

      {lib.broken.length > 0 && (
        <p className={css.broken} role="status">
          {lib.broken.length} {plural(lib.broken.length, 'файл', 'файла', 'файлов')} данных не читается и в статистику не попадает —{' '}
          <Link to="/projects">список на экране «Проекты»</Link>.
        </p>
      )}

      {total === 0 ? (
        <p className={css.empty}>
          {branch === MAIN ? 'Проектов пока нет.' : `В ветке «${branch}» проектов нет.`} Статистика появится, когда будут проекты
          с логом и задачами.
        </p>
      ) : (
        <>
          <dl className={css.kpis}>
            <Kpi label="Записей в логе" value={String(view.log)} />
            <Kpi label="Коммитов" value="—" note="появится с виджетами" muted />
            <Kpi label="Задач закрыто" value={String(view.closed)} />
            <Kpi
              label="Дедлайнов в срок"
              value={percentText(dl.onTimeShare)}
              accent={dl.onTimeShare !== null}
              note={dl.total === 0 ? 'сроков за период нет' : undefined}
            />
          </dl>

          <div className={css.grid}>
            <div className={css.col}>
              <section aria-labelledby="s-pulse">
                <h2 id="s-pulse" className={css.label}>
                  Пульс · {view.pulse.weeks.length} нед
                </h2>
                <StatsHeatmap
                  weeks={view.pulse.weeks}
                  label={`Записи лога по дням за период ${rangeLabel(range)}: всего ${view.log}.`}
                />
                <StatsHeatLegend />
                <p className={css.hint}>Пока только записи лога — коммиты добавятся с виджетами репо.</p>
              </section>

              <section aria-labelledby="s-activity">
                <h2 id="s-activity" className={css.label}>
                  Активность по проектам · записи лога
                </h2>
                {view.activity.length === 0 ? (
                  <p className={css.none}>За период в логе нет записей.</p>
                ) : (
                  <>
                    <ul className={css.activity}>
                      {view.activity.slice(0, ACTIVITY_LIMIT).map((a) => (
                        <li key={a.slug}>
                          <Link to={`/projects/${a.slug}`} className={css.activityRow}>
                            <span className={css.activityName} title={a.title}>
                              {a.title}
                            </span>
                            <StatsMeter share={a.share} />
                            <span className={css.num}>{a.count}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                    {view.activity.length > ACTIVITY_LIMIT && (
                      <p className={css.hint}>
                        Ещё {view.activity.length - ACTIVITY_LIMIT}{' '}
                        {plural(view.activity.length - ACTIVITY_LIMIT, 'проект', 'проекта', 'проектов')} с записями за период.
                      </p>
                    )}
                  </>
                )}
              </section>
            </div>

            <aside className={css.col} aria-label="Сводка">
              <section aria-labelledby="s-status">
                <h2 id="s-status" className={css.label}>
                  Статусы
                </h2>
                <StatsStackBar segments={view.shares.map((s) => ({ key: s.status, value: s.count, tone: s.status }))} />
                <ul className={css.legend}>
                  {view.shares.map((s) => (
                    <li key={s.status} data-tone={s.status}>
                      <span className={css.dot} aria-hidden />
                      {STATUS_LABEL[s.status]}
                      <span className={css.legendCount}>{s.count}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section aria-labelledby="s-deadlines">
                <h2 id="s-deadlines" className={css.label}>
                  Дедлайны
                </h2>
                <StatsStackBar segments={OUTCOMES.map((o) => ({ key: o, value: dl.counts[o], tone: o }))} />
                <ul className={css.rows}>
                  {OUTCOMES.map((o) => (
                    <li key={o} data-tone={o}>
                      <span className={css.dot} aria-hidden />
                      {OUTCOME_LABEL[o]}
                      <span className={css.num}>{dl.counts[o]}</span>
                    </li>
                  ))}
                </ul>
                {dl.total === 0 && <p className={css.hint}>За период ни один срок задачи не наступил.</p>}
              </section>

              <section aria-labelledby="s-published">
                <h2 id="s-published" className={css.label}>
                  Опубликовано
                </h2>
                {view.published.length === 0 ? (
                  <p className={css.none}>За период ни один проект не перешёл в «готово».</p>
                ) : (
                  <ul className={css.rows}>
                    {view.published.map((p) => (
                      <li key={p.slug} data-tone="done">
                        <span className={css.dot} aria-hidden />
                        <Link to={`/projects/${p.slug}`} className={css.pubName} title={p.title}>
                          {p.title}
                        </Link>
                        <span className={css.num}>{shortDate(p.day)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
    </section>
  )
}

function Kpi({ label, value, note, muted, accent }: { label: string; value: string; note?: string; muted?: boolean; accent?: boolean }) {
  return (
    <div className={css.kpi}>
      <dt className={css.kpiLabel}>{label}</dt>
      <dd className={css.kpiValue} data-muted={muted || undefined} data-accent={accent || undefined}>
        {value}
      </dd>
      {note && <dd className={css.kpiNote}>{note}</dd>}
    </div>
  )
}
