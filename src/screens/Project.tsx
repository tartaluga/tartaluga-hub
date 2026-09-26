// Карточка проекта с правкой на месте (C4). Каждая правка — один коммит; правки, сделанные, пока идёт запись,
// склеиваются в следующий (session.saveProject). До ответа сервера на экране уже новое значение; при ошибке оно
// откатывается, а причина видна рядом с полем.
import { lazy, Suspense, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import {
  ArrowLeft,
  Code,
  Copy,
  FileText,
  Folder,
  GithubLogo,
  Globe,
  HardDrives,
  LinkSimple,
  PencilSimple,
  Plus,
  Trash,
  X,
  type Icon,
} from '@phosphor-icons/react'
import { errorText, useSession } from '../app/session'
import { Cover } from '../components/Cover'
import { InlineText } from '../components/InlineText'
import { activityText, buildLibrary, listSearchFromState, STATUS_LABEL, type Status } from '../data/projects'
import { NEXT_STEP_MAX, TITLE_MAX } from '../data/newProject'
import { deleteProject } from '../data/ideas'
import {
  applyEdit,
  DESCRIPTION_MAX,
  EditConflict,
  LINK_KIND_LABEL,
  LINK_KINDS,
  LINK_LABEL_MAX,
  LINK_PLACEHOLDER,
  linkHref,
  linkText,
  mergePatch,
  newLink,
  normalizePatch,
  patchError,
  settledPatch,
  STACK_ITEM_MAX,
  vscodeHref,
  type LinkKind,
  type ProjectPatch,
} from '../data/editProject'
import type { Link as ProjectLink, Project as ProjectData } from '../schema/types'
import { ApiError } from '../lib/api'
import { normalizeProject } from '../data/normalize'
import type { WithUnknown } from '../data/model'
import { ProjectTasks } from '../components/ProjectTasks'
import { CopyContext } from '../components/CopyContext'
import { restoredDraft, useDraftText } from '../lib/drafts'
import { ProjectLog } from './ProjectLog'
import css from './Project.module.css'

// Разбор Markdown — отдельный чанк: стартовый экран его не ждёт, офлайн он в кэше service worker.
const Markdown = lazy(() => import('../components/Markdown').then((m) => ({ default: m.Markdown })))

const STATUSES: Status[] = ['idea', 'active', 'paused', 'done', 'archived']

const LINK_ICON: Record<string, Icon> = { folder: Folder, repo: GithubLogo, site: Globe, local: HardDrives, doc: FileText }

type Save = (patch: ProjectPatch) => Promise<string | null>

export function Project() {
  const { slug = '' } = useParams()
  // Свой экземпляр на каждый проект: неподтверждённые правки и открытые поля не переезжают в другой.
  return <ProjectCard key={slug} slug={slug} />
}

function ProjectCard({ slug }: { slug: string }) {
  const navigate = useNavigate()
  // «Проекты» возвращают на тот фильтр списка, с которого открыли карточку.
  const back = `/projects${listSearchFromState(useLocation().state)}`
  const files = useSession((s) => s.files)
  const sync = useSession((s) => s.sync)
  const saveProject = useSession((s) => s.saveProject)
  const lib = useMemo(() => buildLibrary(files, new Date()), [files])
  const p = lib.projects.find((x) => x.data.slug === slug)
  const broken = lib.broken.find((b) => b.path === `projects/${slug}.json`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Правки, отправленные, но ещё не подтверждённые сервером: показываем их сразу.
  const [pending, setPending] = useState<ProjectPatch>({})

  async function remove(title: string) {
    const ok = window.confirm(
      `Удалить проект «${title}»?\n\nФайл проекта и его обложка удалятся из репо данных одним коммитом, идеи проекта отвяжутся. Вернуть можно только через историю git.`,
    )
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await deleteProject(slug)
      navigate('/projects', { replace: true })
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? 'Данные в репо изменились дважды подряд — обнови страницу и попробуй ещё раз.' : errorText(e))
      setBusy(false)
    }
  }

  const save: Save = async (raw) => {
    const patch = normalizePatch(raw)
    const invalid = patchError(patch)
    if (invalid) return invalid
    setPending((cur) => mergePatch(cur, patch))
    try {
      await saveProject(slug, patch)
      return null
    } catch (e) {
      if (e instanceof EditConflict) return e.message
      if (e instanceof ApiError && e.status === 0) return 'Нет связи с сервером хаба — правка не сохранена. Попробуй, когда появится сеть.'
      if (e instanceof ApiError && e.status === 409) return 'Файл снова изменился в другом месте. Показаны свежие данные — внеси правку ещё раз.'
      return errorText(e)
    } finally {
      // Убираем только свои значения: если поле успели поправить ещё раз, его новое значение остаётся.
      setPending((cur) => settledPatch(cur, patch))
    }
  }

  if (!p) {
    return (
      <section className={css.page}>
        <Link to={back} className={css.back}>
          <ArrowLeft size={16} aria-hidden /> Проекты
        </Link>
        {broken ? (
          <>
            <h1 className={css.title}>{slug}</h1>
            <p className={css.error}>
              Файл <span className="mono">{broken.path}</span> не читается: {broken.error}
            </p>
            <button type="button" className={css.danger} onClick={() => void remove(slug)} disabled={busy}>
              <Trash size={18} aria-hidden /> Удалить файл
            </button>
            {error && <p className={css.error}>{error}</p>}
          </>
        ) : (
          <p className={css.muted}>{sync === 'syncing' ? 'Загружаю…' : 'Такого проекта нет в этой ветке.'}</p>
        )}
      </section>
    )
  }

  // Неподтверждённые правки показываем так, как они будут записаны: originalDue и прочие инварианты v2
  // ставит тот же normalizeProject, что и перед записью, — «перенесено с …» видно сразу.
  const shown = p.data as WithUnknown<ProjectData>
  const d = normalizeProject(shown, applyEdit(shown, pending))
  const ro = p.readOnly
  return (
    <section className={css.page}>
      <Link to={back} className={css.back} viewTransition>
        <ArrowLeft size={16} aria-hidden /> Проекты
      </Link>
      <div className={css.cover} data-status={d.status} style={{ viewTransitionName: `cover-${d.slug}` }}>
        <Cover slug={d.slug} muted={d.status === 'paused' || d.status === 'done' || d.status === 'archived'} />
      </div>
      <div className="eyebrow">
        {STATUS_LABEL[d.status as Status]} · {activityText(p.activityDays)}
      </div>
      <h1 className={css.title}>
        <InlineText value={d.title} placeholder="Без названия" label="Название" maxLength={TITLE_MAX} readOnly={ro} trigger="pencil" draftKey={`project:${d.slug}:title`} onSave={(title) => save({ title })} />
      </h1>
      <div className={css.next}>
        <InlineText
          value={d.nextStep ?? ''}
          display={`→ ${d.nextStep}`}
          placeholder="→ Следующий шаг не задан"
          label="Следующий шаг"
          maxLength={NEXT_STEP_MAX}
          readOnly={ro}
          trigger="pencil"
          draftKey={`project:${d.slug}:nextStep`}
          onSave={(nextStep) => save({ nextStep })}
        />
      </div>
      {ro && <p className={css.notice}>Файл записан новой версией формата данных — править его может только новая версия хаба. Здесь только чтение.</p>}
      {/* Описание — сразу под названием и следующим шагом, а не под задачами. */}
      <div className={css.lead}>
        <Description slug={d.slug} text={d.description ?? ''} readOnly={ro} save={save} />
      </div>

      <StatusPicker status={d.status as Status} readOnly={ro} save={save} />
      <CopyContext project={d} />

      <div className={css.body}>
        <div className={css.main}>
          <ProjectTasks tasks={d.tasks ?? []} milestones={d.milestones ?? []} readOnly={ro} save={save} draftKey={`project:${d.slug}`} />
          <ProjectLog slug={d.slug} log={d.log ?? []} readOnly={ro} save={save} />
        </div>
        <aside className={css.aside}>
          <Stack slug={d.slug} items={d.stack ?? []} readOnly={ro} save={save} />
          <Tags ids={d.tags ?? []} known={lib.tags} settingsProblem={lib.settingsProblem} readOnly={ro} save={save} />
          <Links slug={d.slug} links={d.links ?? []} readOnly={ro} save={save} />
        </aside>
      </div>

      <div className={css.dangerZone}>
        <button type="button" className={css.danger} onClick={() => void remove(d.title)} disabled={busy}>
          <Trash size={18} aria-hidden /> {busy ? 'Удаляю…' : 'Удалить проект'}
        </button>
        {error && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}

/** Сохранение без поля ввода (кнопки, чипы): ошибка показывается под блоком. */
function useAction(save: Save) {
  const [error, setError] = useState<string | null>(null)
  const run = async (patch: ProjectPatch) => {
    setError(null)
    const err = await save(patch)
    setError(err)
    return err
  }
  const alert = error && (
    <p className={css.error} role="alert">
      {error}
    </p>
  )
  return { run, alert }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={css.section}>
      <h2 className={css.sectionTitle}>{title}</h2>
      {children}
    </section>
  )
}

function StatusPicker({ status, readOnly, save }: { status: Status; readOnly: boolean; save: Save }) {
  const { run, alert } = useAction(save)
  return (
    <div className={css.statusRow}>
      <div className={css.segment} role="group" aria-label="Статус">
        {STATUSES.map((s) => (
          <button key={s} type="button" aria-pressed={status === s} data-status={s} disabled={readOnly} onClick={() => status !== s && void run({ status: s })}>
            <span className={css.dot} aria-hidden />
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      {alert}
    </div>
  )
}

function Description({ slug, text, readOnly, save }: { slug: string; text: string; readOnly: boolean; save: Save }) {
  const draftKey = `project:${slug}:description`
  // Черновик описания от прошлой версии хаба (ADR-011) — сразу открыть поле с ним.
  const [editing, setEditing] = useState(() => !readOnly && restoredDraft(draftKey) !== undefined)
  return (
    <Section title="Описание">
      {editing ? (
        <InlineText
          value={text}
          placeholder=""
          label="Описание"
          maxLength={DESCRIPTION_MAX}
          multiline
          autoOpen
          draftKey={draftKey}
          onClose={() => setEditing(false)}
          onSave={(description) => save({ description })}
        />
      ) : (
        <>
          {text ? (
            <Suspense fallback={<p className={css.plain}>{text}</p>}>
              <Markdown text={text} />
            </Suspense>
          ) : <p className={css.muted}>Описания пока нет. Можно Markdown: списки, ссылки, код.</p>}
          {!readOnly && (
            <button type="button" className={css.textButton} onClick={() => setEditing(true)} aria-label={text ? 'Изменить описание' : undefined}>
              <PencilSimple size={15} aria-hidden /> {text ? 'Изменить' : 'Добавить описание'}
            </button>
          )}
        </>
      )}
    </Section>
  )
}

function Stack({ slug, items, readOnly, save }: { slug: string; items: string[]; readOnly: boolean; save: Save }) {
  const { run, alert } = useAction(save)
  const [draft, setDraft] = useDraftText(`project:${slug}:stack`, 'Стек: новый пункт')
  async function add(e: FormEvent) {
    e.preventDefault()
    const item = draft.trim()
    if (!item) return
    if (!(await run({ stack: [...items, item] }))) setDraft('')
  }
  return (
    <Section title="Стек">
      {items.length > 0 && (
        <ul className={css.chips}>
          {items.map((s) => (
            <li key={s} className={css.chip}>
              {s}
              {!readOnly && (
                <button type="button" className={css.chipRemove} aria-label={`Убрать ${s}`} onClick={() => void run({ stack: items.filter((x) => x !== s) })}>
                  <X size={12} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form className={css.addRow} onSubmit={add}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={STACK_ITEM_MAX} placeholder="Добавить: React, Python…" aria-label="Добавить в стек" />
          <button type="submit" className={css.iconButton} aria-label="Добавить в стек" disabled={!draft.trim()}>
            <Plus size={16} aria-hidden />
          </button>
        </form>
      )}
      {readOnly && items.length === 0 && <p className={css.muted}>Не указан</p>}
      {alert}
    </Section>
  )
}

interface TagInfo {
  id: string
  name: string
  color: string
}

function Tags({ ids, known, settingsProblem, readOnly, save }: { ids: string[]; known: TagInfo[]; settingsProblem: string | null; readOnly: boolean; save: Save }) {
  const { run, alert } = useAction(save)
  const [picking, setPicking] = useState(false)
  const byId = new Map(known.map((t) => [t.id, t]))
  const free = known.filter((t) => !ids.includes(t.id))
  return (
    <Section title="Теги">
      {ids.length > 0 && (
        <ul className={css.chips}>
          {ids.map((id) => {
            const t = byId.get(id)
            return (
              <li key={id} className={css.chip} data-unknown={t ? undefined : true} title={t ? undefined : 'Такого тега нет в settings.json'}>
                <span className={css.tagDot} style={{ background: t?.color ?? 'var(--text-faint)' }} aria-hidden />
                {t?.name ?? id}
                {!readOnly && (
                  <button type="button" className={css.chipRemove} aria-label={`Убрать тег ${t?.name ?? id}`} onClick={() => void run({ tags: ids.filter((x) => x !== id) })}>
                    <X size={12} aria-hidden />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {!readOnly &&
        (known.length === 0 ? (
          <p className={css.muted}>{settingsProblem ?? 'Тегов пока нет'} — теги заводятся в настройках.</p>
        ) : picking ? (
          <div className={css.picker} role="group" aria-label="Добавить тег">
            {free.map((t) => (
              <button key={t.id} type="button" className={css.pick} onClick={() => void run({ tags: [...ids, t.id] })}>
                <span className={css.tagDot} style={{ background: t.color }} aria-hidden />
                {t.name}
              </button>
            ))}
            {free.length === 0 && <span className={css.muted}>Все теги уже стоят</span>}
            <button type="button" className={css.textButton} onClick={() => setPicking(false)}>
              Закрыть
            </button>
          </div>
        ) : (
          <button type="button" className={css.textButton} onClick={() => setPicking(true)}>
            <Plus size={15} aria-hidden /> Добавить тег
          </button>
        ))}
      {readOnly && ids.length === 0 && <p className={css.muted}>Нет</p>}
      {alert}
    </Section>
  )
}

function Links({ slug, links, readOnly, save }: { slug: string; links: ProjectLink[]; readOnly: boolean; save: Save }) {
  const { run, alert } = useAction(save)
  const [value, setValue] = useDraftText(`project:${slug}:link`, 'Новая ссылка: адрес')
  const [label, setLabel] = useDraftText(`project:${slug}:link-label`, 'Новая ссылка: подпись')
  const [adding, setAdding] = useState(() => !readOnly && (value !== '' || label !== ''))
  const [kind, setKind] = useState<LinkKind>('site')
  const [formError, setFormError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  async function add(e: FormEvent) {
    e.preventDefault()
    const r = newLink(kind, value, label)
    if (!r.ok) return setFormError(r.error)
    setFormError(null)
    if (!(await run({ links: [...links, r.link] }))) {
      setValue('')
      setLabel('')
      setAdding(false)
    }
  }

  async function copy(link: ProjectLink) {
    try {
      await navigator.clipboard.writeText(link.value)
      setCopied(link.id)
      setTimeout(() => setCopied((c) => (c === link.id ? null : c)), 1500)
    } catch {
      setFormError('Браузер не дал скопировать — выдели путь и скопируй вручную.')
    }
  }

  return (
    <Section title="Ссылки">
      {links.length > 0 && (
        <ul className={css.links}>
          {links.map((l) => {
            const href = linkHref(l)
            const LinkIcon = LINK_ICON[l.kind] ?? LinkSimple
            const text = linkText(l)
            const external = href?.startsWith('http')
            return (
              <li key={l.id} className={css.link}>
                <LinkIcon size={18} className={css.linkIcon} aria-hidden />
                <span className={css.linkMain}>
                  {href ? (
                    <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} title={l.value}>
                      {text}
                    </a>
                  ) : (
                    <span title={l.value}>{text}</span>
                  )}
                  <span className={css.linkKind}>{LINK_KIND_LABEL[l.kind as LinkKind] ?? l.kind}</span>
                </span>
                {l.kind === 'folder' && (
                  <>
                    <button type="button" className={css.iconButton} onClick={() => void copy(l)} aria-label="Скопировать путь" title="Скопировать путь">
                      <Copy size={16} aria-hidden />
                    </button>
                    {copied === l.id && (
                      <span className={css.copied} role="status">
                        скопировано
                      </span>
                    )}
                    {vscodeHref(l.value) && (
                      <a className={css.iconButton} href={vscodeHref(l.value)!} aria-label="Открыть в VS Code" title="Открыть в VS Code">
                        <Code size={16} aria-hidden />
                      </a>
                    )}
                  </>
                )}
                {!readOnly && (
                  <button type="button" className={css.iconButton} aria-label={`Убрать ссылку ${text}`} onClick={() => void run({ links: links.filter((x) => x.id !== l.id) })}>
                    <X size={16} aria-hidden />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {links.length === 0 && <p className={css.muted}>Папка на ПК, репо, сайт, локальный адрес, документы.</p>}
      {!readOnly &&
        (adding ? (
          <form className={css.linkForm} onSubmit={add}>
            <select value={kind} onChange={(e) => setKind(e.target.value as LinkKind)} aria-label="Вид ссылки">
              {LINK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LINK_KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={LINK_PLACEHOLDER[kind]} aria-label="Адрес или путь" autoFocus />
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={LINK_LABEL_MAX} placeholder="Подпись, можно пусто" aria-label="Подпись" />
            <div className={css.formActions}>
              <button type="button" className={css.textButton} onClick={() => (setAdding(false), setFormError(null))}>
                Отмена
              </button>
              <button type="submit" className={css.primary} disabled={!value.trim()}>
                Добавить
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className={css.textButton} onClick={() => setAdding(true)}>
            <Plus size={15} aria-hidden /> Добавить ссылку
          </button>
        ))}
      {formError && (
        <p className={css.error} role="alert">
          {formError}
        </p>
      )}
      {alert}
    </Section>
  )
}
