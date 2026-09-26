// «Проекты» по макету 2a: переключатель статусов со счётчиками, поиск за иконкой, сортировка справа, сетка плиток.
// На телефоне (< 768 px) те же плитки CSS перестраивает в список строк (4-2b). Пустые состояния — по 6-8a/6-8d.
// Фильтр живёт в адресе, поэтому «назад» из карточки возвращает ту же выборку.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { ArrowsDownUp, MagnifyingGlass, Plus, PlusCircle, SquaresFour, Warning, X } from '@phosphor-icons/react'
import { MAIN, useSession } from '../app/session'
import { Cover } from '../components/Cover'
import { NewProjectDialog } from '../components/NewProjectDialog'
import { hasNewProjectDraft } from '../data/newProject'
import {
  activityText,
  applyFilter,
  EMPTY_FILTER,
  isDefaultStatuses,
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
import { useDraft } from '../lib/drafts'
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

/** Черновик строки поиска по проектам. */
const SEARCH_DRAFT = 'projects:search'

export function Projects() {
  const files = useSession((s) => s.files)
  const branch = useSession((s) => s.branch)
  const [params, setParams] = useSearchParams()
  const filter = useMemo(() => filterFromParams(params), [params])
  // Статус не выбран явно — вкладка по умолчанию; правка поиска или тегов её не фиксирует в адресе.
  const implicitStatus = !params.has('status')
  // «Сегодня» для сроков берём один раз на набор файлов: плитки не пересчитываются на каждый ввод в поиск.
  const lib = useMemo(() => buildLibrary(files, new Date()), [files])
  const shown = useMemo(() => applyFilter(lib.projects, filter), [lib, filter])
  const counts = useMemo(() => countByStatus(lib.projects), [lib])
  // Строка поиска живёт в адресе и возвращается вместе с экраном; черновик нужен, когда экран не вернулся (ADR-011 §4).
  const { restored: carriedQuery, discard: discardQuery } = useDraft(SEARCH_DRAFT, filter.query === '' ? undefined : filter.query, 'Поиск по проектам')
  const [searchOpen, setSearchOpen] = useState(filter.query !== '' || carriedQuery !== undefined)
  const [creating, setCreating] = useState(hasNewProjectDraft)
  const titleRef = useRef<HTMLHeadingElement>(null)

  const set = (next: Partial<Filter>) => {
    const implicit = implicitStatus && !('statuses' in next)
    setParams(filterToParams({ ...filter, ...next }, implicit), { replace: true })
  }
  const total = lib.projects.length - counts.archived
  const current = filter.statuses.length === 1 ? filter.statuses[0]! : null
  // «В работе» по умолчанию и «Все» — не фильтр: кнопки сброса при них нет.
  const filtered = filter.query !== '' || filter.tags.length > 0 || (filter.statuses.length > 0 && !isDefaultStatuses(filter.statuses))

  useEffect(() => {
    if (carriedQuery === undefined) return
    if (filter.query === '') setParams(filterToParams({ ...filter, query: carriedQuery }, implicitStatus), { replace: true })
    discardQuery()
  }, [carriedQuery, filter, implicitStatus, setParams, discardQuery])

  function closeSearch() {
    setSearchOpen(false)
    if (filter.query) set({ query: '' })
  }

  // Кнопка сброса после него исчезает; фокус — на заголовок экрана, а не на body.
  function resetFilter() {
    setSearchOpen(false)
    // Сброс показывает всё (status=all), а не вкладку по умолчанию: иначе «Ничего не нашлось» при пустой «В работе» не уйдёт.
    setParams(filterToParams(EMPTY_FILTER), { replace: true })
    titleRef.current?.focus()
  }

  return (
    <section className={css.page}>
      <header className={css.head}>
        <div>
          <div className="eyebrow">
            {total} {plural(total, 'проект', 'проекта', 'проектов')}
            {counts.active > 0 && ` · ${counts.active} в работе`}
          </div>
          <h1 className={css.title} ref={titleRef} tabIndex={-1}>
            Проекты
          </h1>
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
          {/* Без проектов создавать предлагает само пустое состояние, как в макете 6-8a/6-8d. */}
          {lib.projects.length > 0 && (
            <button type="button" className={css.create} onClick={() => setCreating(true)}>
              <Plus size={18} aria-hidden /> Новый проект
            </button>
          )}
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
                <button type="button" className={css.reset} onClick={resetFilter}>
                  <X size={14} aria-hidden /> Сбросить
                </button>
              )}
            </div>
          )}
        </>
      )}

      {lib.projects.length === 0 ? (
        <EmptyLibrary branch={branch} onCreate={() => setCreating(true)} />
      ) : shown.length === 0 ? (
        <NothingFound filter={filter} archived={counts.archived} onReset={resetFilter} />
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

/** Проектов нет совсем. ПК: плитка «Первый проект» и пустые места сетки (6-8a). Телефон: блок внизу экрана и кнопка (6-8d). */
export function EmptyLibrary({ branch, onCreate }: { branch: string; onCreate: () => void }) {
  const onMain = branch === MAIN
  return (
    <div className={css.first} data-branch={onMain ? undefined : ''}>
      <div className={css.firstIntro}>
        <SquaresFour size={40} className={css.firstIcon} aria-hidden />
        <h2 className={css.firstHeading}>{onMain ? 'Проектов пока нет' : `В ветке «${branch}» проектов нет`}</h2>
        <p className={css.firstText}>Начни с названия — остальное добавишь потом.</p>
      </div>
      <ul className={css.slots}>
        <li>
          <button type="button" className={css.firstCard} onClick={onCreate}>
            <PlusCircle size={26} aria-hidden />
            <span className={css.firstCardTitle}>Первый проект</span>
            <span className={css.firstCardText}>Достаточно названия. Остальное — статус, шаг, ссылки — можно добавить потом.</span>
          </button>
        </li>
        {[1, 2, 3].map((i) => (
          <li key={i} className={css.slot} aria-hidden />
        ))}
      </ul>
      <button type="button" className={css.firstButton} onClick={onCreate}>
        <Plus size={20} aria-hidden /> Первый проект
      </button>
    </div>
  )
}

/** Проекты есть, но под фильтр не попал ни один. */
export function NothingFound({ filter, archived, onReset }: { filter: Filter; archived: number; onReset: () => void }) {
  const onlyStatus = filter.query === '' && filter.tags.length === 0 && filter.statuses.length > 0
  const hint =
    filter.query && filter.statuses.length > 0
      ? 'Поиск идёт только по выбранному статусу — открой вкладку «Все».'
      : filter.query && archived > 0
        ? 'Архив в поиск не входит — открой вкладку «Архив».'
        : onlyStatus
          ? 'Проектов с этим статусом нет.'
          : 'Попробуй другой запрос или сбрось фильтры.'
  return (
    <div className={css.none}>
      <MagnifyingGlass size={32} className={css.firstIcon} aria-hidden />
      <h2 className={css.firstHeading}>Ничего не нашлось</h2>
      <p className={css.firstText} role="status">
        {hint}
      </p>
      <button type="button" className={css.noneReset} onClick={onReset}>
        <X size={16} aria-hidden /> Сбросить фильтры
      </button>
    </div>
  )
}

function Tile({ p }: { p: ProjectView }) {
  const d = p.data
  // Фильтр списка едет в карточку, чтобы «Проекты» вернули на ту же вкладку.
  const { search } = useLocation()
  const pct = p.progress === null ? 0 : Math.round(p.progress * 100)
  const hot = p.deadline && isHot(p.deadline) ? p.deadline : null
  return (
    <Link to={`/projects/${d.slug}`} state={{ listSearch: search }} className={css.tile} data-status={d.status} viewTransition>
      <div className={css.coverWrap} style={{ viewTransitionName: `cover-${d.slug}` }}>
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
          <span className={css.rowDot} aria-hidden />
          {/* На телефоне плашки статуса нет, точка — только цвет; статус словом для скринридера. */}
          <span className={css.rowStatus}>{STATUS_LABEL[d.status as Status]}</span>
          <h2 className={css.name} title={d.title}>
            {d.title}
          </h2>
          <span className={css.when} title="Последняя активность">
            {activityText(p.activityDays)}
          </span>
          {/* Строка на телефоне: обложка мала для подписей, поэтому срок или тишина — здесь, вместо «когда». */}
          <span
            className={css.rowMeta}
            data-tone={hot ? 'hot' : p.silentDays !== null ? 'quiet' : undefined}
            title={hot ? `Срок: ${hot.title}` : p.silentDays !== null ? 'В логе давно нет записей' : 'Последняя активность'}
          >
            {hot ? deadlineText(hot) : activityText(p.activityDays)}
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
