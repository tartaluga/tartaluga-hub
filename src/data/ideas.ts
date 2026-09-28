// Идеи (инбокс): разбор ideas/<id>.json для экрана, черновики и правки, запись в репо данных.
// Чистые функции — сверху; запись — внизу, поверх API сессии. Создание и правка идеи идут через очередь правок
// (ADR-004), как правки проекта; удаление и «Сделать проектом» — прямые коммиты (deleteFiles, commit).
// Контракт: schema/README.md (идея v1 + project), ADR-009 (fromIdea, привязка к проекту).
import { ulid } from 'ulid'
import { applyWrite, errorText, hasQueued, useSession } from '../app/session'
import { ApiError, type CommitChange } from '../lib/api'
import type { CachedFile } from '../lib/localdb'
import type { Idea, Project } from '../schema/types'
import { validateIdea } from '../schema/validators.js'
import { nowIso, parseFile, SCHEMA_VERSIONS, serialize, uniqueSlug, type WithUnknown } from './model'
import { newProjectDraft, projectPaths, TITLE_MAX, type NewProjectInput } from './newProject'
import { normalizeProject } from './normalize'

export const IDEA_MAX = 2000

export interface IdeaView {
  path: string
  id: string
  data: WithUnknown<Idea>
  readOnly: boolean
  /** Почему файл только для чтения (формат новее сборки). */
  reason: string | null
  /** Первая непустая строка текста — заголовок в списке. */
  title: string
  /** Slug проекта, к которому привязана идея. */
  project: string | null
  /** Название привязанного проекта; null — проекта нет в ветке («проект удалён»). */
  projectTitle: string | null
}

export interface ProjectRef {
  slug: string
  title: string
  status: Project['status']
}

/** Проект, сделанный из идеи, — колонка «Стали проектами». */
export interface FromIdeaView {
  slug: string
  title: string
  ideaTitle: string
  /** Когда появился проект (createdAt проекта). */
  at: string
}

export interface Inbox {
  ideas: IdeaView[]
  broken: { path: string; error: string }[]
  /** Проекты для привязки: по названию, архив в конце. */
  projects: ProjectRef[]
  fromIdeas: FromIdeaView[]
}

export type IdeaFilter = 'all' | 'free' | 'linked'

export const FILTER_LABEL: Record<IdeaFilter, string> = { all: 'Все', free: 'Без проекта', linked: 'С проектом' }

/** Первая непустая строка, пробелы схлопнуты. */
export function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/\s+/g, ' ')
    if (t) return t
  }
  return ''
}

/**
 * Дополняет ли полный текст заголовок (первую строку): есть другие строки или иное, чем в заголовке.
 * Если нет — в раскрытой идее текст второй раз не показываем.
 */
export function textExtendsTitle(text: string): boolean {
  return text.trim().replace(/\s+/g, ' ') !== firstLine(text)
}

/** Дата «23.09» из момента ISO: берём дату как она записана (местная дата автора), без пересчёта поясов. */
export function shortDate(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}.${m[1]}` : ''
}

const byNewest = (a: { at: string; key: string }, b: { at: string; key: string }) => {
  const ta = Date.parse(a.at)
  const tb = Date.parse(b.at)
  if (ta !== tb) return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta)
  return b.key.localeCompare(a.key)
}

export function buildInbox(files: CachedFile[]): Inbox {
  const rawIdeas: { path: string; data: WithUnknown<Idea>; readOnly: boolean; reason: string | null }[] = []
  const projects: ProjectRef[] = []
  const fromIdeas: FromIdeaView[] = []
  const broken: Inbox['broken'] = []
  for (const f of files) {
    if (!/^(ideas|projects)\//.test(f.path)) continue
    const parsed = parseFile(f.path, f.sha, f.text)
    if (!parsed.ok) {
      if (parsed.kind === 'idea') broken.push({ path: f.path, error: parsed.error })
      continue
    }
    if (parsed.kind === 'idea') {
      rawIdeas.push({ path: f.path, data: parsed.data as WithUnknown<Idea>, readOnly: parsed.readOnly, reason: parsed.readOnly ? parsed.reason : null })
    } else if (parsed.kind === 'project') {
      const p = parsed.data as WithUnknown<Project>
      projects.push({ slug: p.slug, title: p.title, status: p.status })
      if (p.fromIdea) fromIdeas.push({ slug: p.slug, title: p.title, ideaTitle: firstLine(p.fromIdea.text), at: p.createdAt })
    }
  }
  const titles = new Map(projects.map((p) => [p.slug, p.title]))
  const ideas: IdeaView[] = rawIdeas.map(({ path, data, readOnly, reason }) => ({
    path,
    id: data.id,
    data,
    readOnly,
    reason,
    title: firstLine(data.text),
    project: data.project ?? null,
    projectTitle: data.project ? (titles.get(data.project) ?? null) : null,
  }))
  ideas.sort((a, b) => byNewest({ at: a.data.createdAt, key: a.id }, { at: b.data.createdAt, key: b.id }))
  projects.sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived') || a.title.localeCompare(b.title, 'ru'))
  fromIdeas.sort((a, b) => byNewest({ at: a.at, key: a.slug }, { at: b.at, key: b.slug }))
  return { ideas, broken: broken.sort((a, b) => a.path.localeCompare(b.path)), projects, fromIdeas }
}

export function filterIdeas(ideas: IdeaView[], filter: IdeaFilter): IdeaView[] {
  if (filter === 'free') return ideas.filter((i) => !i.project)
  if (filter === 'linked') return ideas.filter((i) => !!i.project)
  return ideas
}

// ---------- Черновики и правки ----------

export type IdeaDraft = { ok: true; id: string; path: string; text: string } | { ok: false; error: string }

// Переводы строк сохраняем (первая строка — заголовок), срезаем только пустоту по краям.
const normText = (raw: string) => raw.replace(/\r\n/g, '\n').trim()

function checkText(raw: string): { ok: true; text: string } | { ok: false; error: string } {
  const text = normText(raw)
  if (!text) return { ok: false, error: 'Пустую идею не сохранить' }
  if (text.length > IDEA_MAX) return { ok: false, error: `Идея длиннее ${IDEA_MAX} символов` }
  return { ok: true, text }
}

/** Черновик новой идеи. id выбирается один раз на попытку создания (schema/README.md, правило 6). */
export function newIdeaDraft(raw: string, now = new Date(), id = ulid(now.getTime())): IdeaDraft {
  const t = checkText(raw)
  if (!t.ok) return t
  const data: Idea = { schemaVersion: SCHEMA_VERSIONS.idea, id, text: t.text, createdAt: nowIso(now) }
  const path = `ideas/${id}.json`
  const text = serialize(data)
  const parsed = parseFile(path, '', text)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, id, path, text }
}

/** Правка идеи: text — новый текст, project — slug или null (отвязать). Поле не передано — не трогаем. */
export interface IdeaPatch {
  text?: string
  project?: string | null
}

/**
 * Применить правку к данным идеи. Незнакомые поля сохраняются. Ошибка — строка для человека.
 * Правка ничего не меняет — changed: false, данные прежние (updatedAt не трогаем, писать нечего).
 */
export function applyIdeaPatch(
  prev: WithUnknown<Idea>,
  patch: IdeaPatch,
  now = new Date(),
): { ok: true; changed: boolean; data: WithUnknown<Idea> } | { ok: false; error: string } {
  const next = structuredClone(prev)
  if (patch.text !== undefined) {
    const t = checkText(patch.text)
    if (!t.ok) return t
    next.text = t.text
  }
  if (patch.project !== undefined) {
    if (patch.project === null) delete next.project
    else next.project = patch.project
  }
  if (serialize(next) === serialize(prev)) return { ok: true, changed: false, data: next }
  next.updatedAt = nowIso(now)
  if (!validateIdea(next)) return { ok: false, error: 'Идея не прошла проверку схемой — не сохранено' }
  return { ok: true, changed: true, data: next }
}

/** Слить две правки идеи из очереди: поля второй поверх первой (ADR-004, одна ожидающая правка на файл). */
export function mergeIdeaPatch(a: IdeaPatch, b: IdeaPatch): IdeaPatch {
  const out: IdeaPatch = { ...a }
  if (b.text !== undefined) out.text = b.text
  if (b.project !== undefined) out.project = b.project
  return out
}

/** Название проекта из идеи: первая строка, не длиннее TITLE_MAX. */
export function titleFromIdea(text: string): string {
  const line = firstLine(text)
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
}

export type ProjectFromIdeaDraft = { ok: true; slug: string; path: string; text: string } | { ok: false; error: string }

/** Проект из идеи: обычный новый проект плюс fromIdea (ADR-009) и теги идеи. */
export function projectFromIdeaDraft(idea: Idea, input: NewProjectInput, taken: Iterable<string>, now = new Date()): ProjectFromIdeaDraft {
  const base = newProjectDraft(input, taken, now)
  if (!base.ok) return base
  const data = JSON.parse(base.text) as WithUnknown<Project>
  data.fromIdea = { ideaId: idea.id, text: idea.text, createdAt: idea.createdAt }
  if (idea.tags?.length) data.tags = [...idea.tags]
  const text = serialize(normalizeProject(undefined, data, data.createdAt))
  const parsed = parseFile(base.path, '', text)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, slug: base.slug, path: base.path, text }
}

/**
 * Удаляя проект, хаб отвязывает его идеи тем же коммитом (ADR-009): изменения для этих идей.
 * Идеи с форматом новее сборки не трогаем — их поле project покажет «проект удалён».
 */
export function unlinkIdeasChanges(slug: string, files: CachedFile[], now = new Date()): CommitChange[] {
  const out: CommitChange[] = []
  for (const f of files) {
    if (!f.path.startsWith('ideas/')) continue
    const parsed = parseFile(f.path, f.sha, f.text)
    if (!parsed.ok || parsed.readOnly || parsed.kind !== 'idea') continue
    const data = parsed.data as WithUnknown<Idea>
    if (data.project !== slug) continue
    const r = applyIdeaPatch(data, { project: null }, now)
    if (r.ok && r.changed) out.push({ path: f.path, text: serialize(r.data) })
  }
  return out
}

// ---------- Запись ----------

/** Текст ошибки записи для человека. */
/** Код ошибки: сделано только на устройстве, текст ошибки — для экрана как есть. */
const LOCAL_ONLY = 'local_only'

export function ideaErrorText(e: unknown, what: string): string {
  if (e instanceof ApiError && e.code === LOCAL_ONLY) return e.message
  if (e instanceof ApiError && e.status === 0) return `Нет связи с сервером хаба — ${what}. Попробуй, когда появится сеть.`
  return errorText(e)
}

/** Идея на экране: данные и sha, от которого считается правка. */
function currentIdea(branch: string, path: string): { sha: string; data: WithUnknown<Idea> } {
  const state = useSession.getState()
  if (state.branch !== branch) throw new ApiError(0, 'network', 'Открыта другая ветка — правка не отправлена')
  const file = state.files.find((f) => f.path === path)
  if (!file) throw new ApiError(404, 'not_found', 'Идеи больше нет в этой ветке')
  const parsed = parseFile(path, file.sha, file.text)
  if (!parsed.ok) throw new ApiError(422, 'validation', `Файл не читается: ${parsed.error}`)
  if (parsed.readOnly) throw new ApiError(422, 'validation', parsed.reason)
  return { sha: file.sha, data: parsed.data as WithUnknown<Idea> }
}

/**
 * Записать новую идею через очередь правок (ADR-004): сразу видна на экране и лежит на устройстве, без сети уходит,
 * когда появится связь. Повторяемо: тот же черновик (тот же ULID) дубль не создаст (schema/README.md, правило 6).
 * Промис завершается, когда идея записана или отложена; если в репо уже другая идея с этим id — QueueConflict.
 */
export async function createIdea(draft: { path: string; text: string }): Promise<void> {
  await useSession.getState().addIdea(draft.path, draft.text)
}

/**
 * Правка идеи через очередь правок (ADR-004), как правка проекта: одна ожидающая правка на файл, при конфликте —
 * трёхстороннее слияние, спорное — во «Входящие конфликты» (QueueConflict). Правка без изменений ничего не пишет.
 */
export async function saveIdea(id: string, patch: IdeaPatch): Promise<void> {
  const state = useSession.getState()
  const path = `ideas/${id}.json`
  const r = applyIdeaPatch(currentIdea(state.branch, path).data, patch)
  if (!r.ok) throw new ApiError(422, 'validation', r.error)
  if (!r.changed) return // правка ничего не меняет — пустой коммит не нужен
  await state.saveIdea(path, patch)
}

/**
 * Удалить проект (файл и обложки) и отвязать его идеи тем же коммитом (ADR-009).
 * Идей больше, чем влезает в коммит, — остаток отвязывается следующими коммитами (session.deleteFiles).
 */
export async function deleteProject(slug: string): Promise<void> {
  await useSession.getState().deleteFiles((tree) => projectPaths(slug, tree.paths), `Хаб: удалить проект ${slug}`, (files) => unlinkIdeasChanges(slug, files))
}

/** Идея убрана с устройства, а удалить её из репо не вышло: нет свежей сверки с репо. */
export const DELETED_ONLY_ON_DEVICE =
  'Идея удалена только с устройства: нет связи с репо. Если она успела туда записаться, после сверки появится снова — тогда удали её ещё раз.'

/**
 * Удалить идею одним коммитом. Уже удалена — успех. Идея ещё в очереди (создана без сети) — убрать из очереди
 * и удалить из репо: прошлая попытка создания могла дойти, а ответ потеряться. Удаляем только по дереву свежей
 * успешной сверки: в старом дереве идеи может не быть, и удаление сочло бы её «уже удалённой», а она вернулась бы
 * при следующей сверке. Сверка не удалась (нет сети, 5xx, 429) — ошибка DELETED_ONLY_ON_DEVICE, удаление
 * не считается выполненным: если идея окажется в репо, она останется видна.
 */
export async function deleteIdea(id: string): Promise<void> {
  const path = `ideas/${id}.json`
  const session = useSession.getState()
  if (await session.discardNew(path)) {
    const branch = session.branch
    // Дважды: первая сверка может оказаться той, что уже шла до записи идеи, — её дерево старое.
    await useSession.getState().refresh()
    if (useSession.getState().sync === 'idle') await useSession.getState().refresh()
    const s = useSession.getState()
    if (s.sync !== 'idle' || !s.tree || s.branch !== branch) throw new ApiError(0, LOCAL_ONLY, DELETED_ONLY_ON_DEVICE)
    try {
      await s.deleteFiles(() => [path], `Идеи: удалить ${id}`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) throw new ApiError(0, LOCAL_ONLY, DELETED_ONLY_ON_DEVICE)
      throw e
    }
    return
  }
  await session.deleteFiles(() => [path], `Идеи: удалить ${id}`)
}

async function freshTree(previousHead?: string) {
  const s = useSession.getState()
  if (s.tree && s.tree.head !== previousHead) return s.tree
  await s.refresh()
  let tree = useSession.getState().tree
  if (tree && previousHead && tree.head === previousHead) {
    await useSession.getState().refresh()
    tree = useSession.getState().tree
  }
  return tree
}

/** Файл идеи на экране — та же идея, что в черновике проекта (по содержимому, со всеми полями). */
function sameIdea(file: CachedFile | undefined, idea: Idea): boolean {
  if (!file) return false
  const parsed = parseFile(file.path, file.sha, file.text)
  return parsed.ok && !parsed.readOnly && serialize(parsed.data) === serialize(idea)
}

/**
 * «Сделать проектом»: файл проекта и удаление файла идеи одним коммитом (ADR-009).
 * Черновик (slug и текст) выбирается до первой попытки и не меняется при повторах; idea — версия идеи,
 * из которой он собран: если файл идеи с тех пор изменили, коммита нет (409 idea_changed).
 */
export async function makeProjectFromIdea(idea: Idea, draft: { slug: string; path: string; text: string }): Promise<void> {
  const ideaId = idea.id
  const ideaPath = `ideas/${ideaId}.json`
  const branch = useSession.getState().branch
  // Правка идеи ещё в очереди: коммит удалил бы идею из репо без неё. Сперва отправляем очередь.
  if (hasQueued(branch, ideaPath)) {
    await useSession.getState().flush()
    if (hasQueued(branch, ideaPath)) throw new ApiError(0, 'network', 'Идея ещё не записана в репо — проект можно сделать, когда она отправится')
  }
  let head: string | undefined
  for (let attempt = 0; ; attempt++) {
    const tree = await freshTree(head)
    if (!tree || useSession.getState().branch !== branch) throw new ApiError(0, 'network', 'Нет связи с сервером хаба — проект не создан')
    head = tree.head
    if (tree.paths.includes(draft.path)) {
      // Повтор после обрыва связи: наш коммит уже прошёл, если проект тот же, а идеи уже нет.
      const file = useSession.getState().files.find((f) => f.path === draft.path)
      if (!tree.paths.includes(ideaPath) && file?.text === draft.text) return
      throw new ApiError(409, 'slug_taken', `Проект «${draft.slug}» уже есть в репо. Измени название.`)
    }
    if (!tree.paths.includes(ideaPath)) throw new ApiError(404, 'not_found', 'Идеи больше нет в этой ветке')
    // Идею удаляем, только если это та самая версия, из которой собран проект: иначе чужая правка пропадёт.
    if (!sameIdea(useSession.getState().files.find((f) => f.path === ideaPath), idea)) {
      throw new ApiError(409, 'idea_changed', 'Идею изменили на другом устройстве — проект не создан. Открой «Сделать проектом» заново.')
    }
    const changes: CommitChange[] = [
      { path: draft.path, text: draft.text },
      { path: ideaPath, text: null },
    ]
    try {
      const res = await useSession.getState().remote.commit(branch, changes, tree.head, `Идеи: ${ideaId} → проект ${draft.slug}`)
      await applyWrite(branch, [{ path: draft.path, sha: res.shas[draft.path] ?? '', text: draft.text }], [ideaPath], res.head)
      void useSession.getState().refresh()
      return
    } catch (e) {
      // Ветку сдвинули после сверки: перечитываем дерево и пробуем ещё раз, но только один.
      if (!(e instanceof ApiError && e.status === 409) || attempt > 0) throw e
    }
  }
}

/** Свободный slug для проекта из идеи — для подсказки в форме. */
export function slugPreview(title: string, taken: Iterable<string>): string {
  return title.trim() ? uniqueSlug(title, taken) : '…'
}
