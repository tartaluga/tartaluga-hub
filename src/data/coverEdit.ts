// Смена и удаление своей обложки проекта (G2). Один атомарный коммит: файл covers/<slug>.<ext> и projects/<slug>.json
// с полем cover (ADR-010 п.3 — обложка и проект группа).
// MVP-ограничения: только онлайн и только если у проекта нет неотправленной правки в очереди
// (иначе пришлось бы сливать очередь с коммитом).
import { applyWrite, hasQueued, onlyWriter, useSession, writeRemote } from '../app/session'
import { ApiError, type CommitChange } from '../lib/api'
import { bytesToBase64 } from '../lib/base64'
import { deviceEpoch, putCoverIfCurrent, saveCoverIndex } from '../lib/localdb'
import { sniffCover } from '../lib/coverImage'
import { applyEdit, type ProjectPatch } from './editProject'
import { serialize } from './model'

export const OFFLINE_HINT = 'Обложку можно сменить только онлайн'
export const BANNER_OFFLINE_HINT = 'Шапку можно сменить только онлайн'
export const QUEUE_HINT = 'Сначала дождитесь отправки правок проекта'

export interface NewCover {
  bytes: Uint8Array
  ext: 'webp' | 'jpg'
}

const COVER_EXTS = ['webp', 'jpg'] as const

/** Какая картинка проекта: обложка (covers/, поле cover) или шапка (banners/, поле banner, ADR-016). Конвейер записи общий. */
export type ImageKind = 'cover' | 'banner'
const DIR: Record<ImageKind, string> = { cover: 'covers', banner: 'banners' }
const WORD: Record<ImageKind, { gen: string; acc: string; fail: string; offline: string }> = {
  cover: { gen: 'обложки', acc: 'обложку', fail: 'Нет связи с сервером хаба — обложка не отправлена', offline: OFFLINE_HINT },
  banner: { gen: 'шапки', acc: 'шапку', fail: 'Нет связи с сервером хаба — шапка не отправлена', offline: BANNER_OFFLINE_HINT },
}

/**
 * Набор изменений коммита. cover === null — убрать обложку. Старый файл с другим расширением удаляется в том же
 * коммите; незнакомые поля проекта сохраняются.
 */
export function buildCoverChanges(slug: string, projectText: string, cover: NewCover | null, treePaths: string[], now = new Date(), kind: ImageKind = 'cover'): CommitChange[] {
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(projectText)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not object')
    data = parsed as Record<string, unknown>
  } catch {
    throw new ApiError(422, 'validation', `Файл проекта не читается — ${WORD[kind].acc} менять нельзя`)
  }
  const path = cover ? `${DIR[kind]}/${slug}.${cover.ext}` : null
  const patch = { [kind]: path } as unknown as ProjectPatch
  const changes: CommitChange[] = []
  if (cover && path) changes.push({ path, base64: bytesToBase64(cover.bytes) })
  for (const ext of COVER_EXTS) {
    const p = `${DIR[kind]}/${slug}.${ext}`
    if (p !== path && treePaths.includes(p)) changes.push({ path: p, base64: null })
  }
  changes.push({ path: `projects/${slug}.json`, text: serialize(applyEdit(data, patch, now)) })
  return changes
}

/**
 * Записать (cover) или убрать (null) обложку. 409 — голова ветки сменилась: данные перечитываются, ошибка
 * отдаётся экрану, тот предлагает повторить с тем же выбранным кадром.
 */
export const saveCover = onlyWriter((slug: string, cover: NewCover | null): Promise<void> => saveImage('cover', slug, cover))

/** То же для шапки проекта (banners/<slug>.<ext>, поле banner). */
export const saveBanner = onlyWriter((slug: string, banner: NewCover | null): Promise<void> => saveImage('banner', slug, banner))

async function saveImage(kind: ImageKind, slug: string, cover: NewCover | null): Promise<void> {
  const branch = useSession.getState().branch
  const epoch = deviceEpoch() // «Выйти» во время коммита: после стирания устройства в базу ничего не пишем
  const jsonPath = `projects/${slug}.json`
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ApiError(0, 'network', WORD[kind].offline)
  if (hasQueued(branch, jsonPath)) throw new ApiError(423, 'queue_pending', QUEUE_HINT)
  if (cover && sniffCover(cover.bytes) !== (cover.ext === 'webp' ? 'image/webp' : 'image/jpeg')) throw new ApiError(422, 'validation', 'Картинка не прошла проверку')
  if (!useSession.getState().tree) await useSession.getState().refresh()
  const tree = useSession.getState().tree
  const file = useSession.getState().files.find((f) => f.path === jsonPath)
  if (!tree || useSession.getState().branch !== branch) throw new ApiError(0, 'network', WORD[kind].fail)
  if (!file) throw new ApiError(404, 'not_found', 'Проекта нет в этой ветке')
  const changes = buildCoverChanges(slug, file.text, cover, tree.paths, new Date(), kind)
  const message = cover ? `Хаб: ${kind === 'cover' ? 'обложка' : 'шапка'} проекта ${slug}` : `Хаб: убрать ${WORD[kind].acc} проекта ${slug}`
  let res: { head: string; shas: Record<string, string> }
  try {
    res = await writeRemote().commit(branch, changes, tree.head, message)
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      useSession.setState({ tree: null })
      await useSession.getState().refresh()
    }
    throw e
  }
  const removed = changes.filter((c) => 'base64' in c && c.base64 === null).map((c) => c.path)
  const json = changes.find((c) => c.path === jsonPath) as { text: string }
  await applyWrite(branch, [{ path: jsonPath, sha: res.shas[jsonPath] ?? '', text: json.text }], removed, res.head)
  // Новая обложка видна сразу: байты кладём в кэш по sha из ответа и обновляем индекс обложек ветки.
  const covers = { ...(useSession.getState().tree?.covers ?? tree.covers ?? {}) }
  for (const p of removed) delete covers[p]
  if (cover) {
    const p = `${DIR[kind]}/${slug}.${cover.ext}`
    const sha = res.shas[p]
    if (sha) {
      covers[p] = sha
      const type = cover.ext === 'webp' ? 'image/webp' : 'image/jpeg'
      await putCoverIfCurrent(epoch, { sha, type, bytes: new Blob([cover.bytes as BlobPart], { type }) }).catch(() => undefined)
    }
  }
  const t = useSession.getState().tree
  if (t && useSession.getState().branch === branch) useSession.setState({ tree: { ...t, covers } })
  if (epoch === deviceEpoch()) saveCoverIndex(branch, covers)
  void useSession.getState().refresh()
}
