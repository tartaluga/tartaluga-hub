// Кнопки «Поставить / Сменить шапку» и «Убрать шапку» в карточке проекта и диалог кадра 5:2 (G4.6, ADR-016).
// Тот же конвейер, что у обложки: checkSourceFile → renderBanner → saveBanner (атомарный коммит). Только онлайн,
// без неотправленной правки проекта, не во вкладке просмотра.
import { useEffect, useId, useRef, useState } from 'react'
import { Image as ImageIcon, Trash } from '@phosphor-icons/react'
import { errorText, hasQueued, useSession } from '../app/session'
import { saveBanner, BANNER_OFFLINE_HINT, QUEUE_HINT } from '../data/coverEdit'
import { ApiError } from '../lib/api'
import { BANNER_MAX_ZOOM, CoverImageError, bannerFrameOf, checkSourceFile, renderBanner, type BannerPos } from '../lib/coverFrame'
import { useOnline } from '../lib/online'
import css from './CoverEditor.module.css'

const RETRY_409 = 'Ветку данных изменили в другом месте. Данные обновлены — нажми «Сохранить шапку» ещё раз, кадр сохранён.'

function failText(e: unknown): string {
  if (e instanceof CoverImageError) return e.message
  if (e instanceof ApiError && e.status === 409) return RETRY_409
  if (e instanceof ApiError && e.status === 0) return BANNER_OFFLINE_HINT
  return errorText(e)
}

export function BannerEditor({ slug, hasOwn }: { slug: string; hasOwn: boolean }) {
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
  const hint = !online ? BANNER_OFFLINE_HINT : pending ? QUEUE_HINT : null
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
    if (!window.confirm('Убрать шапку? Вверху карточки снова будет обложка.')) return
    setBusy(true)
    setError(null)
    try {
      await saveBanner(slug, null)
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
        data-testid="banner-file"
        onChange={(e) => {
          pick(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <button type="button" className={css.btn} disabled={disabled} title={hint ?? undefined} onClick={() => input.current?.click()}>
        <ImageIcon size={16} aria-hidden /> {hasOwn ? 'Сменить шапку' : 'Поставить шапку'}
      </button>
      {hasOwn && (
        <button type="button" className={css.btn} disabled={disabled} title={hint ?? undefined} onClick={() => void remove()}>
          <Trash size={16} aria-hidden /> Убрать шапку
        </button>
      )}
      {error && (
        <span className={css.error} role="alert">
          {error}
        </span>
      )}
      {file && <BannerDialog slug={slug} file={file} onClose={() => setFile(null)} />}
    </div>
  )
}

function BannerDialog({ slug, file, onClose }: { slug: string; file: File; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  const [pos, setPos] = useState<BannerPos>({ x: 0.5, y: 0.5, zoom: 1 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

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
    setSize(null)
    return () => URL.revokeObjectURL(u)
  }, [file])

  // Тот же кадр, что вырежет renderBanner: картинка сдвигается и растягивается внутри рамки 5:2.
  const f = size ? bannerFrameOf(size.w, size.h, pos) : null
  const imgStyle = f && size ? { width: `${(size.w / f.sw) * 100}%`, left: `${(-f.sx / f.sw) * 100}%`, top: `${(-f.sy / f.sh) * 100}%` } : undefined

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const banner = await renderBanner(file, pos)
      await saveBanner(slug, banner)
      onClose()
    } catch (e) {
      setError(failText(e))
      setBusy(false)
    }
  }

  const slider = (key: 'x' | 'y', label: string, from: string, to: string) => (
    <label className={css.slider} htmlFor={`${id}-${key}`}>
      <span className="eyebrow">{label}</span>
      <input id={`${id}-${key}`} type="range" min={0} max={100} step={1} value={Math.round(pos[key] * 100)} disabled={busy} onChange={(e) => setPos({ ...pos, [key]: Number(e.target.value) / 100 })} aria-valuetext={`${Math.round(pos[key] * 100)}%`} />
      <span className={css.ends}>
        <span>{from}</span>
        <span>{to}</span>
      </span>
    </label>
  )

  return (
    <dialog ref={ref} className={css.dialog} aria-labelledby={`${id}-t`} onCancel={(e) => { e.preventDefault(); if (!busy) onClose() }}>
      <div className={css.body}>
        <h2 id={`${id}-t`} className={css.title}>
          Шапка проекта
        </h2>
        <p className={css.hint}>1500 × 600 · 5:2. Двигай и приближай кадр. Сохранится WebP; обложка не меняется.</p>
        <div className={`${css.frame} ${css.frameBanner}`}>
          {url && <img src={url} alt="" style={imgStyle} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />}
        </div>
        {slider('x', 'По горизонтали', 'лево', 'право')}
        {slider('y', 'По вертикали', 'верх', 'низ')}
        <label className={css.slider} htmlFor={`${id}-z`}>
          <span className="eyebrow">Приближение</span>
          <input id={`${id}-z`} type="range" min={100} max={BANNER_MAX_ZOOM * 100} step={5} value={Math.round(pos.zoom * 100)} disabled={busy} onChange={(e) => setPos({ ...pos, zoom: Number(e.target.value) / 100 })} aria-valuetext={`${Math.round(pos.zoom * 100)}%`} />
        </label>
        {error && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}
        <div className={css.actions}>
          <button type="button" className={css.primary} disabled={busy} onClick={() => void save()}>
            {busy ? 'Сохраняю…' : 'Сохранить шапку'}
          </button>
          <button type="button" className={css.ghost} disabled={busy} onClick={onClose}>
            Отмена
          </button>
        </div>
      </div>
    </dialog>
  )
}
