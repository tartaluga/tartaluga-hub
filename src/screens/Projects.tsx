// «Проекты» по макету 2a: переключатель статусов со счётчиками, поиск за иконкой, сортировка справа, сетка плиток.
// Фильтр живёт в адресе, поэтому «назад» из карточки возвращает ту же выборку.
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ArrowsDownUp, MagnifyingGlass, Plus, Warning, X } from '@phosphor-icons/react'
import { MAIN, useSession } from '../app/session'
import { Cover } from '../components/Cover'
import { NewProjectDialog } from '../components/NewProjectDialog'
import {
  activityText,
  applyFilter,
  buildLibrary,
  countByStatus,
  deadlineText,
  filterFromParams,
  filterToParams,
  isHot,
  SORT_LABEL,
  STATUS_LABEL,
  type Filter,
  type ProjectView,
  type SortKey,
  type Status,
} from '../data/projects'
import { plural } from '../lib/plural'
import css from './Projects.module.css'

const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item])

// Порядок и подписи вкладок — как в макете. Архив — отдельная вкладка в конце, только если он не пуст.
const TABS: { status: Status | null; label: string }[] = [
  { status: null, label: 'Все' },
  { status: 'active', label: 'В работе' },
  { status: 'idea', label: 'Идеи' },
  { status: 'paused', label: 'Пауза' },
  { status: 'done', label: 'Готово' },
  { status: 'archived', label: 'Архив' },
]

export function Projects() {
  const files = useSession((s) => s.files)
  const branch = useSession((s) => s.branch)
  const [params, setParams] = useSearchParams()
  const filter = useMemo(() => filterFromParams(params), [params])
  // «Сегодня» для сроков берём один раз на набор файлов: плитки не пересчитываются на каждый ввод в поиск.
  const lib = useMemo(() => buildLibrary(files, new Date()), [files])
  const shown = useMemo(() => applyFilter(lib.projects, filter), [lib, filter])
  const counts = useMemo(() => countByStatus(lib.projects), [lib])
  const [searchOpen, setSearchOpen] = useState(filter.query !== '')
  const [creating, setCreating] = useState(false)

  const set = (next: Partial<Filter>) => setParams(filterToParams({ ...filter, ...next }), { replace: true })
  const total = lib.projects.length - counts.archived
  const current = filter.statuses.length === 1 ? filter.statuses[0]! : null
  const filtered = filter.query !== '' || filter.statuses.length > 0 || filter.tags.length > 0

  function closeSearch() {
    setSearchOpen(false)
    if (filter.query) set({ query: '' })
  }

  return (
    <section className={css.page}>
      <header className={css.head}>
        <div>
          <div className="eyebrow">
            {total} {plural(total, 'проект', 'проекта', 'проектов')}
            {counts.active > 0 && ` · ${counts.active} в работе`}
          </div>
          <h1 className={css.title}>Проекты</h1>
        </div>
        <div className={css.headActions}>
          {lib.projects.length > 0 &&
            (searchOpen ? (
              <label className={css.search}>
                <MagnifyingGlass size={18} aria-hidden />
                <input
                  type="search"
                  value={filter.query}
                  onChange={(e) => set({ query: e.target.value })}
                  onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
                  placeholder="Поиск"
                  aria-label="Поиск по проектам"
                  autoFocus
                />
                <button type="button" className={css.searchClose} onClick={closeSearch} aria-label="Закрыть поиск">
                  <X size={16} aria-hidden />
                </button>
              </label>
            ) : (
              <button type="button" className={css.iconButton} onClick={() => setSearchOpen(true)} aria-label="Поиск по проектам">
                <MagnifyingGlass size={20} aria-hidden />
              </button>
            ))}
          <button type="button" className={css.create} onClick={() => setCreating(true)}>
            <Plus size={18} aria-hidden /> Новый проект
          </button>
        </div>
      </header>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />

      {lib.projects.length > 0 && (
        <>
          <div className={css.bar}>
            <div className={css.tabs} role="group" aria-label="Статус">
              {TABS.filter((t) => t.status !== 'archived' || counts.archived > 0).map((t) => (
                <button
                  key={t.label}
                  type="button"
                  className={css.tab}
                  aria-pressed={current === t.status && (t.status !== null || filter.statuses.length === 0)}
                  onClick={() => set({ statuses: t.status ? [t.status] : [] })}
                >
                  {t.label}
                  <span className={css.count}>{t.status ? counts[t.status] : total}</span>
                </button>
              ))}
            </div>
            <label className={css.sort}>
              <ArrowsDownUp size={16} aria-hidden />
              <select value={filter.sort} onChange={(e) => set({ sort: e.target.value as SortKey })} aria-label="Сортировка">
                {Object.entries(SORT_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {lib.tags.length > 0 && (
            <div className={css.tags} role="group" aria-label="Теги">
              {lib.tags.map((t) => (
                <button key={t.id} type="button" className={css.tag} aria-pressed={filter.tags.includes(t.id)} onClick={() => set({ tags: toggle(filter.tags, t.id) })}>
                  <span className={css.tagDot} style={{ background: t.color }} aria-hidden />
                  {t.name}
                </button>
              ))}
              {filtered && (
                <button type="button" className={css.reset} onClick={() => setParams({}, { replace: true })}>
                  <X size={14} aria-hidden /> Сбросить
                </button>
              )}
            </div>
          )}
        </>
      )}

      {lib.projects.length === 0 ? (
        <p className={css.empty}>
          {branch === MAIN ? 'Проектов пока нет.' : `В ветке «${branch}» проектов нет.`} Начни с кнопки «Новый проект».
        </p>
      ) : shown.length === 0 ? (
        <p className={css.empty}>
          Ничего не нашлось.{' '}
          {filter.query && !filter.statuses.includes('archived') && counts.archived > 0 && 'Архив в поиск не входит — открой вкладку «Архив».'}
        </p>
      ) : (
        <ul className={css.grid}>
          {shown.map((p) => (
            <li key={p.path}>
              <Tile p={p} />
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

function Tile({ p }: { p: ProjectView }) {
  const d = p.data
  const pct = p.progress === null ? 0 : Math.round(p.progress * 100)
  const hot = p.deadline && isHot(p.deadline) ? p.deadline : null
  return (
    <Link to={`/projects/${d.slug}`} className={css.tile} data-status={d.status}>
      <div className={css.coverWrap}>
        <Cover slug={d.slug} muted={d.status === 'paused' || d.status === 'done' || d.status === 'archived'} />
        <span className={css.pill}>
          <span className={css.dot} aria-hidden />
          {STATUS_LABEL[d.status as Status]}
        </span>
        {hot ? (
          <span className={css.badge} data-tone="hot" title={`Срок: ${hot.title}`}>
            {deadlineText(hot)}
          </span>
        ) : (
          p.silentDays !== null && (
            <span className={css.badge} data-tone="quiet" title="В логе давно нет записей">
              {p.silentDays} дн тишины
            </span>
          )
        )}
      </div>
      <div className={css.body}>
        <div className={css.titleRow}>
          <h2 className={css.name} title={d.title}>
            {d.title}
          </h2>
          <span className={css.when} title="Последняя активность">
            {activityText(p.activityDays)}
          </span>
        </div>
        <p className={css.next} data-empty={!d.nextStep || undefined} title={d.nextStep || undefined}>
          {d.nextStep ? `→ ${d.nextStep}` : 'Следующий шаг не задан'}
          {p.readOnly && <span className={css.ro}> · только чтение</span>}
        </p>
        <div className={css.progress} title={p.tasksTotal ? `Задачи: ${p.tasksDone} из ${p.tasksTotal}` : 'Задач пока нет'}>
          <div className={css.track}>
            <div className={css.fill} style={{ width: `${pct}%` }} />
          </div>
          <span className="mono">{pct}%</span>
        </div>
      </div>
    </Link>
  )
}
