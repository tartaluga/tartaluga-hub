// Черновик нового проекта: slug из названия, файл по схеме. Чистая функция — сеть и хранилище в session.ts.
// Черновик собирается один раз на попытку создания и переиспользуется при повторе (schema/README.md, правило 6):
// тот же путь с тем же текстом сервер считает успехом, поэтому повтор после обрыва связи не создаст дубль.
import type { Project } from '../schema/types'
import { nowIso, parseFile, SCHEMA_VERSIONS, serialize, uniqueSlug } from './model'
import { normalizeProject } from './normalize'
import { restoredDraft } from '../lib/drafts'

export interface NewProjectInput {
  title: string
  status: Project['status']
  nextStep: string
}

export type Draft = { ok: true; slug: string; path: string; text: string } | { ok: false; error: string }

export const TITLE_MAX = 120
export const NEXT_STEP_MAX = 200

/** takenSlugs — slug всех проектов открытой ветки, включая нечитаемые файлы. */
export function newProjectDraft(input: NewProjectInput, takenSlugs: Iterable<string>, now = new Date()): Draft {
  const title = input.title.trim().replace(/\s+/g, ' ')
  const nextStep = input.nextStep.trim().replace(/\s+/g, ' ')
  if (!title) return { ok: false, error: 'Нужно название' }
  if (title.length > TITLE_MAX) return { ok: false, error: `Название длиннее ${TITLE_MAX} символов` }
  if (nextStep.length > NEXT_STEP_MAX) return { ok: false, error: `Следующий шаг длиннее ${NEXT_STEP_MAX} символов` }

  const slug = uniqueSlug(title, takenSlugs)
  const at = nowIso(now)
  const data: Project = {
    schemaVersion: SCHEMA_VERSIONS.project,
    slug,
    title,
    status: input.status,
    ...(nextStep ? { nextStep } : {}),
    createdAt: at,
    updatedAt: at,
  }
  const path = `projects/${slug}.json`
  // Новый проект сразу в формате v2: «готово» при создании получает doneAt (ADR-009, п. 6).
  const text = serialize(normalizeProject(undefined, data, at))
  // Сервер проверит то же самое, но так ошибка видна сразу и без сети.
  const parsed = parseFile(path, '', text)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, slug, path, text }
}

/** slug всех файлов projects/*.json в списке путей — читаемых и нет: занятый битым файлом slug тоже занят. */
export function takenSlugs(paths: Iterable<string>): string[] {
  const out: string[] = []
  for (const p of paths) {
    const m = /^projects\/([^/]+)\.json$/.exec(p)
    if (m) out.push(m[1]!)
  }
  return out
}

/**
 * Что удаляется вместе с проектом: его файл и его обложки covers/<slug>.webp|.jpg.
 * Поле cover не используется: его мог вписать кто угодно, и оно может указывать на обложку другого проекта.
 */
export function projectPaths(slug: string, treePaths: string[]): string[] {
  const own = new Set([`projects/${slug}.json`, `covers/${slug}.webp`, `covers/${slug}.jpg`])
  return treePaths.filter((p) => own.has(p))
}

/** Ключи черновиков формы «Новый проект» (ADR-011): незаконченная форма переживает обновление хаба. */
export const NEW_PROJECT_DRAFT = { title: 'new-project:title', nextStep: 'new-project:nextStep' } as const

/** От прошлой версии хаба пришла незаконченная форма — экран открывает окно сразу. */
export function hasNewProjectDraft(): boolean {
  return restoredDraft(NEW_PROJECT_DRAFT.title) !== undefined || restoredDraft(NEW_PROJECT_DRAFT.nextStep) !== undefined
}
