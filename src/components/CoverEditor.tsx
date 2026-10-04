// Кнопки «Сменить обложку» / «Убрать обложку» в карточке проекта и диалог предпросмотра кадра 16:6 (G2).
// MVP: только онлайн, без неотправленной правки проекта, не во вкладке просмотра.
import { useEffect, useId, useRef, useState } from 'react'
import { Image as ImageIcon, Trash } from '@phosphor-icons/react'
import { errorText, hasQueued, useSession } from '../app/session'
import { saveCover, OFFLINE_HINT, QUEUE_HINT } from '../data/coverEdit'
import { ApiError } from '../lib/api'
import { CoverImageError, checkSourceFile, renderCover } from '../lib/coverFrame'
import { useOnline } from '../lib/online'
import css from './CoverEditor.module.css'

const RETRY_409 = 'Ветку данных изменили в другом месте. Данные обновлены — нажми «Сохранить» ещё раз, кадр сохранён.'

function failText(e: unknown): string {
  if (e instanceof CoverImageError) return e.message
  if (e instanceof ApiError && e.status === 409) return RETRY_409
  if (e instanceof ApiError && e.status === 0) return OFFLINE_HINT
  return errorText(e)
}

export function CoverEditor({ slug, hasOwn }: { slug: string; hasOwn: boolean }) {
  const online = useOnline()
  const readOnly = useSession((s) => s.readOnly)
  const queued = useSession((s) => s.queued)
  const branch = useSession((s) => s.branch)
  const pending = queued > 0 && hasQueued(branch, `projects/${slug}.json`)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  if (readOnly) return null
  const hint = !online ? OFFLINE_HINT : pending ? QUEUE_HINT : null
  const disabled = hint !== null || busy

  const pick = (f: File | undefined) => {
    if (!f) return
    try {
      checkSourceFile(f)
      setError(null)
      setFile(f)
    } catch (e) {
      setError(failText(e))
    }
  }

  const remove = async () => {
    if (!window.confirm('Убрать свою обложку? Вместо неё снова будет заставка.')) return
    setBusy(true)
    setError(null)
    try {
      await saveCover(slug, null)
    } catch (e) {
      setError(failText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.bar}>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className={css.file}
        tabIndex={-1}
        aria-hidden
        data-testid="cover-file"
        onChange={(e) => {
          pick(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <button type="button" className={css.btn} disabled={disabled} title={hint ?? undefined} onClick={() => input.current?.click()}>
        <ImageIcon size={16} aria-hidden /> Сменить обложку
      </button>
      {hasOwn && (
        <button type="button" className={css.btn} disabled={disabled} title={hint ?? undefined} onClick={() => void remove()}>
          <Trash size={16} aria-hidden /> Убрать обложку
        </button>
      )}
      {hint && <span className={css.hint}>{hint}</span>}
      {error && (
        <span className={css.error} role="alert">
          {error}
        </span>
      )}
      {file && <CoverDialog slug={slug} file={file} onClose={() => setFile(null)} />}
    </div>
  )
}

function CoverDialog({ slug, file, onClose }: { slug: string; file: File; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  const [offset, setOffset] = useState(0.5)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
    return () => {
      if (d?.open) d.close()
    }
  }, [])

  // Предпросмотр — object URL исходника с явным типом растра; освобождаем при закрытии.
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([file], { type: file.type }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const cover = await renderCover(file, offset)
      await saveCover(slug, cover)
      onClose()
    } catch (e) {
      setError(failText(e))
      setBusy(false)
    }
  }

  return (
    <dialog ref={ref} className={css.dialog} aria-labelledby={`${id}-t`} onCancel={(e) => { e.preventDefault(); if (!busy) onClose() }}>
      <div className={css.body}>
        <h2 id={`${id}-t`} className={css.title}>
          Обложка проекта
        </h2>
        <div className={css.frame}>
          {url && <img src={url} alt="" style={{ objectPosition: `50% ${Math.round(offset * 100)}%` }} />}
        </div>
        <label className={css.slider} htmlFor={`${id}-r`}>
          <span className="eyebrow">Положение кадра</span>
          <input id={`${id}-r`} type="range" min={0} max={100} step={1} value={Math.round(offset * 100)} disabled={busy} onChange={(e) => setOffset(Number(e.target.value) / 100)} aria-valuetext={`${Math.round(offset * 100)}% от верха`} />
          <span className={css.ends}>
            <span>верх</span>
            <span>низ</span>
          </span>
        </label>
        {error && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}
        <div className={css.actions}>
          <button type="button" className={css.primary} disabled={busy} onClick={() => void save()}>
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
          <button type="button" className={css.ghost} disabled={busy} onClick={onClose}>
            Отмена
          </button>
        </div>
      </div>
    </dialog>
  )
}
