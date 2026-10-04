// Правка проекта из экрана: проект из библиотеки, сохранение через очередь и неподтверждённые правки, которые
// сразу видны на экране (общее для карточки проекта и страницы задачи).
import { useMemo, useState } from 'react'
import { ApiError } from '../lib/api'
import { applyEdit, EditConflict, mergePatch, normalizePatch, patchError, settledPatch, type ProjectPatch } from '../data/editProject'
import { buildLibrary } from '../data/projects'
import { normalizeProject } from '../data/normalize'
import type { WithUnknown } from '../data/model'
import type { Project } from '../schema/types'
import { errorText, useSession } from './session'
import { useWidgets } from './widgets'

export type Save = (patch: ProjectPatch) => Promise<string | null>

export function useProjectEditing(slug: string) {
  const files = useSession((s) => s.files)
  const sync = useSession((s) => s.sync)
  const saveProject = useSession((s) => s.saveProject)
  const commits = useWidgets((s) => s.commits)
  const lib = useMemo(() => buildLibrary(files, new Date(), commits), [files, commits])
  const p = lib.projects.find((x) => x.data.slug === slug)
  const broken = lib.broken.find((b) => b.path === `projects/${slug}.json`)
  // Правки, отправленные, но ещё не подтверждённые сервером: показываем их сразу.
  const [pending, setPending] = useState<ProjectPatch>({})

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

  // Неподтверждённые правки показываем так, как они будут записаны: originalDue и прочие инварианты v2
  // ставит тот же normalizeProject, что и перед записью, — «перенесено с …» видно сразу.
  const shown = p ? (p.data as WithUnknown<Project>) : null
  const d = shown ? normalizeProject(shown, applyEdit(shown, pending)) : null
  return { lib, p, d, broken, sync, save, ro: p?.readOnly ?? false }
}
