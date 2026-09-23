// Карточка проекта. Пока — основное и удаление; поля с правкой на месте, ссылки и лог появятся следующим шагом (C4–C6).
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft, Trash } from '@phosphor-icons/react'
import { errorText, useSession } from '../app/session'
import { Cover } from '../components/Cover'
import { activityText, buildLibrary, STATUS_LABEL, type Status } from '../data/projects'
import { projectPaths } from '../data/newProject'
import { ApiError } from '../lib/api'
import css from './Project.module.css'

export function Project() {
  const { slug = '' } = useParams()
  const navigate = useNavigate()
  const files = useSession((s) => s.files)
  const sync = useSession((s) => s.sync)
  const deleteFiles = useSession((s) => s.deleteFiles)
  const lib = useMemo(() => buildLibrary(files, new Date()), [files])
  const p = lib.projects.find((x) => x.data.slug === slug)
  const broken = lib.broken.find((b) => b.path === `projects/${slug}.json`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove(title: string) {
    const ok = window.confirm(
      `Удалить проект «${title}»?\n\nФайл проекта и его обложка удалятся из репо данных одним коммитом. Вернуть можно только через историю git.`,
    )
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await deleteFiles((tree) => projectPaths(slug, tree.paths), `Хаб: удалить проект ${slug}`)
      navigate('/projects', { replace: true })
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? 'Данные в репо изменились дважды подряд — обнови страницу и попробуй ещё раз.' : errorText(e))
      setBusy(false)
    }
  }

  if (!p) {
    return (
      <section className={css.page}>
        <Link to="/projects" className={css.back}>
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

  const d = p.data
  return (
    <section className={css.page}>
      <Link to="/projects" className={css.back}>
        <ArrowLeft size={16} aria-hidden /> Проекты
      </Link>
      <div className={css.cover} data-status={d.status}>
        <Cover slug={d.slug} muted={d.status === 'paused' || d.status === 'done' || d.status === 'archived'} />
      </div>
      <div className="eyebrow">
        {STATUS_LABEL[d.status as Status]} · {activityText(p.activityDays)}
      </div>
      <h1 className={css.title}>{d.title}</h1>
      <p className={css.next}>{d.nextStep ? `→ ${d.nextStep}` : 'Следующий шаг не задан'}</p>
      {p.readOnly && <p className={css.muted}>Файл записан новой версией формата — пока только чтение.</p>}
      <p className={css.muted}>Правка полей на месте, ссылки и лог появятся следующим шагом.</p>

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
