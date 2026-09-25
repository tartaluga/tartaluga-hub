// «Сегодня» по макету 1a: что горит в ближайшие 3 дня, следующие шаги, заброшенные, пульс лога и статусы.
// Экран только читает: быстрая заметка из макета появится вместе с записью идей и лога (C5/D4).
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ArrowsDownUp, Plus } from '@phosphor-icons/react'
import { MAIN, useSession } from '../app/session'
import { Cover } from '../components/Cover'
import { NewProjectDialog } from '../components/NewProjectDialog'
import { hasNewProjectDraft } from '../data/newProject'
import { parseLocalDate } from '../data/model'
import { buildLibrary, STATUS_LABEL, type ProjectView } from '../data/projects'
import { abandoned, eyebrowDate, hotItems, hotWhen, localKey, nextSteps, pulse, pulseCaption, statusShares, summary } from '../data/today'
import { plural } from '../lib/plural'
import css from './Today.module.css'

// На главном экране — самое свежее; остальное в «Проектах», чтобы при 30 проектах экран не превращался в список.
const NEXT_LIMIT = 6

/** Текущее время, обновляется раз в 15 с: часы в надзаголовке идут, а после полуночи меняется «сегодня». */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(id)
  }, [])
  return now
}

// Порядок заброшенных — удобство одного устройства, поэтому в localStorage; без него — по умолчанию.
const QUIET_ORDER_KEY = 'today.quietestFirst'

function readQuietOrder(): boolean {
  try {
    return localStorage.getItem(QUIET_ORDER_KEY) !== 'false'
  } catch {
    return true
  }
}

export function Today() {
  const files = useSession((s) => s.files)
  const branch = useSession((s) => s.branch)
  const now = useNow()
  const [creating, setCreating] = useState(hasNewProjectDraft)
  const [quietestFirst, setQuietestFirst] = useState(readQuietOrder)
  // Пересчитываем только при смене файлов или дня, а не на каждый тик часов.
  const day = localKey(now)
  const view = useMemo(() => {
    // Для сроков и тишины важен только календарный день: берём его полночь.
    const today = parseLocalDate(day)
    const lib = buildLibrary(files, today)
    return {
      lib,
      today,
      hot: hotItems(lib.projects, today),
      next: nextSteps(lib.projects),
      quiet: abandoned(lib.projects, quietestFirst),
      pulse: pulse(lib.projects, today),
      shares: statusShares(lib.projects),
      active: lib.projects.filter((p) => p.data.status === 'active').length,
    }
  }, [files, day, quietestFirst])
  const { lib, hot, next, quiet, active } = view
  const total = lib.projects.length

  return (
    <section className={css.page}>
      <header className={css.head}>
        <div>
          <div className="eyebrow">
            <time dateTime={now.toISOString()}>{eyebrowDate(now)}</time>
          </div>
          <h1 className={css.title}>Сегодня</h1>
          {total > 0 && <p className={css.summary}>{summary(hot, quiet.length, total)}</p>}
        </div>
        <button type="button" className={css.create} onClick={() => setCreating(true)}>
          <Plus size={18} aria-hidden /> Новый проект
        </button>
      </header>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />

      {/* Битые файлы выпадают из всех списков — иначе «проектов нет» или «ничего не горит» вводили бы в заблуждение. */}
      {lib.broken.length > 0 && (
        <p className={css.broken} role="status">
          {lib.broken.length} {plural(lib.broken.length, 'файл', 'файла', 'файлов')} данных не читается и сюда не попадает —{' '}
          <Link to="/projects">список на экране «Проекты»</Link>.
        </p>
      )}

      {total === 0 ? (
        <p className={css.empty}>
          {branch === MAIN ? 'Проектов пока нет.' : `В ветке «${branch}» проектов нет.`} Начни с кнопки «Новый проект» — здесь
          появятся сроки, следующие шаги и пульс.
        </p>
      ) : (
        <div className={css.grid}>
          <div className={css.main}>
            <section aria-labelledby="t-hot">
              <h2 id="t-hot" className={`${css.label} ${css.hotLabel}`}>
                Горит · 3 дня
              </h2>
              {hot.length === 0 ? (
                <p className={css.none}>Ничего не горит: сроков на ближайшие 3 дня нет.</p>
              ) : (
                <ul className={css.hotList}>
                  {hot.map((h) => (
                    <li key={`${h.slug}/${h.id}`}>
                      <Link to={`/projects/${h.slug}`} className={css.hotRow} data-overdue={h.days < 0 || undefined} data-today={h.days === 0 || undefined}>
                        <span className={css.when}>{hotWhen(h)}</span>
                        <span className={css.hotTitle} title={h.title}>
                          {h.kind === 'milestone' && <span className={css.kind}>веха</span>}
                          {h.title}
                        </span>
                        <span className={css.hotProject} title={h.project}>
                          {h.project}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="t-next">
              <h2 id="t-next" className={css.label}>
                Следующие шаги
              </h2>
              {next.length === 0 ? (
                <p className={css.none}>
                  {active === 0 ? 'Нет проектов в работе.' : 'У проектов в работе не задан следующий шаг — его можно вписать в карточке.'}
                </p>
              ) : (
                <>
                  <ul className={css.nextList}>
                    {next.slice(0, NEXT_LIMIT).map((p) => (
                      <li key={p.path}>
                        <NextRow p={p} />
                      </li>
                    ))}
                  </ul>
                  {next.length > NEXT_LIMIT && (
                    <Link to="/projects?status=active" className={css.more}>
                      Ещё {next.length - NEXT_LIMIT} {plural(next.length - NEXT_LIMIT, 'проект', 'проекта', 'проектов')} в работе →
                    </Link>
                  )}
                </>
              )}
            </section>
          </div>

          <aside className={css.side} aria-label="Обзор">
            <section aria-labelledby="t-quiet">
              <div className={css.labelRow}>
                <h2 id="t-quiet" className={css.label}>
                  Заброшенные · &gt;{lib.abandonedAfterDays} дн
                </h2>
                {quiet.length > 1 && (
                  <button
                    type="button"
                    className={css.order}
                    onClick={() => {
                      const next = !quietestFirst
                      setQuietestFirst(next)
                      try {
                        localStorage.setItem(QUIET_ORDER_KEY, String(next))
                      } catch {
                        /* без хранилища порядок просто не запомнится */
                      }
                    }}
                    title="Поменять порядок"
                  >
                    <ArrowsDownUp size={14} aria-hidden /> {quietestFirst ? 'сначала тихие' : 'сначала недавние'}
                  </button>
                )}
              </div>
              {quiet.length === 0 ? (
                <p className={css.none}>{active === 0 ? 'Нет проектов в работе.' : 'Все проекты в работе живые.'}</p>
              ) : (
                <ul className={css.quietList}>
                  {quiet.map((p) => (
                    <li key={p.path}>
                      <Link to={`/projects/${p.data.slug}`} className={css.quietCard}>
                        <span className={css.thumb}>
                          <Cover slug={p.data.slug} muted />
                        </span>
                        <span className={css.quietText}>
                          <span className={css.quietName} title={p.data.title}>
                            {p.data.title}
                          </span>
                          <span className={css.quietStep} data-empty={!p.data.nextStep?.trim() || undefined}>
                            {p.data.nextStep?.trim() || 'Следующий шаг не задан'}
                          </span>
                        </span>
                        <span className={css.quietDays} title="Дней без записей в логе">
                          {p.silentDays} дн
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="t-pulse">
              <h2 id="t-pulse" className={css.label}>
                Пульс · 12 нед
              </h2>
              <div
                className={css.heat}
                role="img"
                aria-label={`Записи лога по дням за 12 недель. ${pulseCaption(view.pulse.monthCount, view.today)}`}
              >
                {view.pulse.weeks.flat().map((d) => (
                  <span
                    key={d.date}
                    className={css.cell}
                    data-level={d.level}
                    data-future={d.future || undefined}
                    title={d.future ? undefined : `${d.date.slice(8)}.${d.date.slice(5, 7)} · ${d.count} ${plural(d.count, 'запись', 'записи', 'записей')}`}
                  />
                ))}
              </div>
              <p className={css.caption}>{pulseCaption(view.pulse.monthCount, view.today)}</p>
            </section>

            <section aria-labelledby="t-status">
              <h2 id="t-status" className={css.label}>
                Статусы
              </h2>
              <div className={css.bar} aria-hidden>
                {view.shares
                  .filter((s) => s.count > 0)
                  .map((s) => (
                    <span key={s.status} data-status={s.status} style={{ flexGrow: s.count }} />
                  ))}
              </div>
              <ul className={css.legend}>
                {view.shares.map((s) => (
                  <li key={s.status} data-status={s.status}>
                    <span className={css.dot} aria-hidden />
                    {STATUS_LABEL[s.status]}
                    <span className={css.legendCount}>{s.count}</span>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      )}
    </section>
  )
}

function NextRow({ p }: { p: ProjectView }) {
  const pct = p.progress === null ? null : Math.round(p.progress * 100)
  return (
    <Link to={`/projects/${p.data.slug}`} className={css.nextRow}>
      <span className={css.thumb}>
        <Cover slug={p.data.slug} />
      </span>
      <span className={css.nextText}>
        <span className={css.nextStep} title={p.data.nextStep}>
          {p.data.nextStep}
        </span>
        <span className={css.nextProject}>{p.data.title}</span>
      </span>
      <span className={css.nextProgress} title={p.tasksTotal ? `Задачи: ${p.tasksDone} из ${p.tasksTotal}` : 'Задач пока нет'}>
        <span className={css.pct}>{pct === null ? '—' : `${pct}%`}</span>
        <span className={css.track}>
          <span className={css.fill} style={{ width: `${pct ?? 0}%` }} />
        </span>
      </span>
    </Link>
  )
}
