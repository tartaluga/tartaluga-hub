// «Проекты»: сетка плиток с поиском, фильтрами по статусу и тегам и сортировкой.
// Фильтр живёт в адресе, поэтому «назад» из карточки возвращает ту же выборку.
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { MagnifyingGlass, Warning, X } from '@phosphor-icons/react'
import { MAIN, useSession } from '../app/session'
import { Cover } from '../components/Cover'
import {
  applyFilter,
  buildLibrary,
  deadlineText,
  filterFromParams,
  filterToParams,
  isHot,
  SORT_LABEL,
  STATUS_LABEL,
  STATUSES,
  type Filter,
  type ProjectView,
  type SortKey,
  type Status,
} from '../data/projects'
import type { Tag } from '../schema/types'
import { plural } from '../lib/plural'
import css from './Projects.module.css'

const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item])

export function Projects() {
  const files = useSession((s) => s.files)
  const branch = useSession((s) => s.branch)
  const [params, setParams] = useSearchParams()
  const filter = useMemo(() => filterFromParams(params), [params])
  // «Сегодня» для сроков берём один раз на набор файлов: плитки не пересчитываются на каждый ввод в поиск.
  const lib = useMemo(() => buildLibrary(files, new Date()), [files])
  const shown = useMemo(() => applyFilter(lib.projects, filter), [lib, filter])
  const tagsById = useMemo(() => new Map(lib.tags.map((t) => [t.id, t])), [lib.tags])

  const set = (next: Partial<Filter>) => setParams(filterToParams({ ...filter, ...next }), { replace: true })
  const filtered = filter.query !== '' || filter.statuses.length > 0 || filter.tags.length > 0
  const archived = lib.projects.filter((p) => p.data.status === 'archived').length
  const total = lib.projects.length - archived

  return (
    <section className={css.page}>
      <header className={css.head}>
        <div>
          <div className="label">
            {total} {plural(total, 'проект', 'проекта', 'проектов')}
            {archived > 0 && ` · ${archived} в архиве`}
          </div>
          <h1 className={css.title}>Проекты</h1>
        </div>
      </header>

      {lib.projects.length > 0 && (
        <>
          <div className={css.toolbar}>
            <label className={css.search}>
              <MagnifyingGlass size={18} aria-hidden />
              <input
                type="search"
                value={filter.query}
                onChange={(e) => set({ query: e.target.value })}
                placeholder="Поиск"
                aria-label="Поиск по проектам"
              />
            </label>
            <select className={css.sort} value={filter.sort} onChange={(e) => set({ sort: e.target.value as SortKey })} aria-label="Сортировка">
              {Object.entries(SORT_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className={css.chips} role="group" aria-label="Статус">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                className={css.chip}
                data-status={s}
                aria-pressed={filter.statuses.includes(s)}
                onClick={() => set({ statuses: toggle(filter.statuses, s) })}
              >
                <span className={css.dot} aria-hidden />
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          {lib.tags.length > 0 && (
            <div className={css.chips} role="group" aria-label="Теги">
              {lib.tags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={css.chip}
                  aria-pressed={filter.tags.includes(t.id)}
                  onClick={() => set({ tags: toggle(filter.tags, t.id) })}
                >
                  <span className={css.dot} style={{ background: t.color }} aria-hidden />
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {filtered && (
            <button type="button" className={css.reset} onClick={() => setParams({}, { replace: true })}>
              <X size={14} aria-hidden /> Сбросить фильтры
            </button>
          )}
        </>
      )}

      {lib.projects.length === 0 ? (
        <p className={css.empty}>
          {branch === MAIN ? 'Проектов пока нет.' : `В ветке «${branch}» проектов нет.`} Создание проекта из хаба появится следующим шагом.
        </p>
      ) : shown.length === 0 ? (
        <p className={css.empty}>
          Ничего не нашлось. {!filter.statuses.length && archived > 0 && 'Архив скрыт — выбери статус «архив», чтобы искать и в нём.'}
        </p>
      ) : (
        <ul className={css.grid}>
          {shown.map((p) => (
            <li key={p.path}>
              <Tile p={p} tags={tagsById} />
            </li>
          ))}
        </ul>
      )}

      {(lib.broken.length > 0 || (lib.settingsProblem && lib.projects.length > 0)) && (
        <div className={css.problems} role="status">
          <div className={css.problemsHead}>
            <Warning size={18} aria-hidden /> Файлы, которые хаб не смог прочитать
          </div>
          <ul>
            {lib.broken.map((b) => (
              <li key={b.path}>
                <span className="mono">{b.path}</span> — {b.error}
              </li>
            ))}
            {lib.settingsProblem && !lib.broken.some((b) => b.path === 'settings.json') && <li>{lib.settingsProblem}</li>}
          </ul>
        </div>
      )}
    </section>
  )
}

function Tile({ p, tags }: { p: ProjectView; tags: Map<string, Tag> }) {
  const d = p.data
  const pct = p.progress === null ? null : Math.round(p.progress * 100)
  return (
    <Link to={`/projects/${d.slug}`} className={css.tile} data-status={d.status}>
      <div className={css.coverWrap}>
        <Cover slug={d.slug} />
        {p.deadline && (
          <span className={css.deadline} data-hot={isHot(p.deadline) || undefined} title={`Срок: ${p.deadline.title}`}>
            {deadlineText(p.deadline)}
          </span>
        )}
      </div>
      <div className={css.body}>
        <div className={css.status}>
          <span className={css.dot} aria-hidden />
          {STATUS_LABEL[d.status as Status]}
          {p.readOnly && <span className={css.ro}> · только чтение</span>}
        </div>
        <h2 className={css.name}>{d.title}</h2>
        <p className={css.next} data-empty={!d.nextStep || undefined}>
          {d.nextStep || 'Следующий шаг не задан'}
        </p>
        {(d.tags?.length ?? 0) > 0 && (
          <div className={css.tags}>
            {d.tags!.slice(0, 3).map((id) => {
              const t = tags.get(id)
              return (
                <span key={id} className={css.tag}>
                  <span className={css.dot} style={t ? { background: t.color } : undefined} aria-hidden />
                  {t?.name ?? id}
                </span>
              )
            })}
            {d.tags!.length > 3 && <span className={css.tag}>+{d.tags!.length - 3}</span>}
          </div>
        )}
        {pct !== null && (
          <div className={css.progress} title={`Задачи: ${p.tasksDone} из ${p.tasksTotal}`}>
            <div className={css.bar}>
              <div className={css.fill} style={{ width: `${pct}%` }} />
            </div>
            <span className="mono">{pct}%</span>
          </div>
        )}
      </div>
    </Link>
  )
}
