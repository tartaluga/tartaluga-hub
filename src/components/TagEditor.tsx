// Список тегов из settings.json: переименование на месте, цвет из палитры, удаление, новый тег,
// порядок — перетаскиванием за ручку (мышь и палец) или стрелками ↑/↓ с клавиатуры на ручке.
// Пока запись идёт, список показывает результат сразу; ошибка возвращает то, что в файле.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { DotsSixVertical, Plus, Trash } from '@phosphor-icons/react'
import { InlineText } from './InlineText'
import { restoredDraft } from '../lib/drafts'
import { errorText } from '../app/session'
import {
  addTag,
  dropIndex,
  moveTag,
  nextColor,
  PALETTE,
  recolorTag,
  removeTag,
  removeWarning,
  renameTag,
  TAG_NAME_MAX,
  tagNameError,
  type SettingsChange,
  type Tag,
} from './TagEditor.model'
import css from './TagEditor.module.css'

interface Props {
  tags: Tag[]
  /** Файл нельзя править (битый или новой версии) — только показываем. */
  readOnly?: boolean
  /** Сколько проектов помечено каждым тегом (id → число) — для предупреждения при удалении. */
  usage?: Record<string, number>
  onChange(change: SettingsChange): Promise<void>
  /** Удалить тег из настроек и снять его со всех проектов (одним коммитом). */
  onRemove(id: string): Promise<void>
}

/** Черновик названия нового тега (ADR-011): переживает обновление хаба. */
const NEW_TAG_DRAFT = 'settings:new-tag'

interface Drag {
  id: string
  from: number
  y0: number
  dy: number
  mids: number[]
  index: number
}

export function TagEditor({ tags, readOnly, usage = {}, onChange, onRemove }: Props) {
  const [optimistic, setOptimistic] = useState<Tag[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paletteFor, setPaletteFor] = useState<string | null>(null)
  const [adding, setAdding] = useState(() => !readOnly && restoredDraft(NEW_TAG_DRAFT) !== undefined)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const pending = useRef(0)
  const list = useRef<HTMLUListElement>(null)
  // Куда вернуть фокус после перерисовки: перестановка переносит строку в DOM, и браузер снимает с неё фокус.
  const refocus = useRef<{ id: string; target: 'handle' | 'swatch' } | null>(null)

  useEffect(() => {
    const want = refocus.current
    if (!want) return
    const row = [...(list.current?.querySelectorAll<HTMLElement>('[data-tag-row]') ?? [])].find((r) => r.dataset.tagRow === want.id)
    const el = row?.querySelector<HTMLElement>(want.target === 'handle' ? '[data-handle]' : '[data-swatch]')
    // Фокус возвращаем, только если он потерялся (ушёл на body), — не отнимаем его у другого поля.
    const lost = !document.activeElement || document.activeElement === document.body
    if (el && lost) el.focus()
    // Пока запись идёт, список ещё раз перерисуется из файла — до тех пор следим за фокусом.
    if (pending.current === 0) refocus.current = null
  })
  const view = optimistic ?? tags

  /**
   * Применить правку к экрану сразу и отправить; null — получилось, строка — ошибка.
   * inline — ошибку покажет поле ввода, под списком её не дублируем.
   */
  async function run(change: SettingsChange, inline = false, send: () => Promise<void> = () => onChange(change)): Promise<string | null> {
    setError(null)
    setOptimistic((prev) => change({ schemaVersion: 1, tags: prev ?? tags }).tags)
    pending.current++
    try {
      await send()
      return null
    } catch (e) {
      const text = errorText(e)
      if (!inline) setError(text)
      return text
    } finally {
      if (--pending.current === 0) setOptimistic(null)
    }
  }

  /** Тег стоит на проектах — сначала подтверждение внутри страницы; без проектов — сразу. */
  function remove(tag: Tag, confirmed = false) {
    if (!confirmed && (usage[tag.id] ?? 0) > 0) {
      setPaletteFor(null)
      setConfirming(tag.id)
      return
    }
    setConfirming(null)
    void run(removeTag(tag.id), false, () => onRemove(tag.id))
  }

  function cancelRemove(id: string) {
    setConfirming(null)
    refocus.current = { id, target: 'swatch' }
  }

  function startDrag(e: PointerEvent<HTMLButtonElement>, id: string, from: number) {
    if (readOnly || e.button !== 0) return
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-tag-row]') ?? [])]
    const mids = rows.map((r) => {
      const b = r.getBoundingClientRect()
      return b.top + b.height / 2
    })
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
    setPaletteFor(null)
    setDrag({ id, from, y0: e.clientY, dy: 0, mids, index: from })
  }

  function moveDrag(e: PointerEvent) {
    if (!drag) return
    setDrag({ ...drag, dy: e.clientY - drag.y0, index: dropIndex(drag.mids, drag.from, e.clientY) })
  }

  function endDrag(commit: boolean) {
    if (!drag) return
    setDrag(null)
    if (commit && drag.index !== drag.from) void run(moveTag(drag.id, drag.index))
  }

  function onHandleKey(e: KeyboardEvent, id: string, index: number) {
    const to = e.key === 'ArrowUp' ? index - 1 : e.key === 'ArrowDown' ? index + 1 : -1
    if (to < 0 || to >= view.length) return
    e.preventDefault()
    refocus.current = { id, target: 'handle' }
    void run(moveTag(id, to))
  }

  // Линия «сюда встанет»: перед строкой others[index] или после последней.
  const others = drag ? view.filter((t) => t.id !== drag.id) : []
  const dropBefore = drag && drag.index !== drag.from ? others[drag.index]?.id : undefined
  const dropAfter = drag && drag.index !== drag.from && drag.index >= others.length ? others.at(-1)?.id : undefined

  return (
    <div className={css.editor}>
      {view.length === 0 && !adding && <p className={css.empty}>Тегов пока нет.</p>}
      <ul className={css.list} ref={list}>
        {view.map((tag, i) => {
          const dragging = drag?.id === tag.id
          return (
            <li
              key={tag.id}
              data-tag-row={tag.id}
              className={css.item}
              data-dragging={dragging || undefined}
              data-drop={tag.id === dropBefore ? 'before' : tag.id === dropAfter ? 'after' : undefined}
              style={dragging ? { transform: `translateY(${drag.dy}px)` } : undefined}
            >
              <div className={css.row}>
                {!readOnly && (
                  <button
                    type="button"
                    className={css.handle}
                    data-handle
                    aria-label={`Порядок тега «${tag.name}»: перетащи или нажми ↑/↓`}
                    title="Перетащи, чтобы поменять порядок"
                    onPointerDown={(e) => startDrag(e, tag.id, i)}
                    onPointerMove={moveDrag}
                    onPointerUp={() => endDrag(true)}
                    onPointerCancel={() => endDrag(false)}
                    onKeyDown={(e) => onHandleKey(e, tag.id, i)}
                  >
                    <DotsSixVertical size={18} aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  className={css.swatch}
                  data-swatch
                  style={{ background: tag.color }}
                  disabled={readOnly}
                  aria-label={`Цвет тега «${tag.name}»`}
                  aria-expanded={paletteFor === tag.id}
                  onClick={() => setPaletteFor(paletteFor === tag.id ? null : tag.id)}
                />
                <div className={css.name}>
                  <InlineText
                    value={tag.name}
                    label={`Название тега «${tag.name}»`}
                    placeholder="Название"
                    maxLength={TAG_NAME_MAX}
                    readOnly={readOnly}
                    draftKey={`settings:tag:${tag.id}:name`}
                    onSave={async (text) => tagNameError(text, view, tag.id) ?? run(renameTag(tag.id, text), true)}
                  />
                </div>
                {!readOnly && (
                  <button
                    type="button"
                    className={css.remove}
                    aria-label={`Удалить тег «${tag.name}»`}
                    aria-expanded={confirming === tag.id}
                    title="Удалить тег"
                    onClick={() => remove(tag)}
                  >
                    <Trash size={16} aria-hidden />
                  </button>
                )}
              </div>
              {confirming === tag.id && !readOnly && (
                <RemoveConfirm tag={tag} count={usage[tag.id] ?? 0} onConfirm={() => remove(tag, true)} onCancel={() => cancelRemove(tag.id)} />
              )}
              {paletteFor === tag.id && !readOnly && (
                <div
                  className={css.palette}
                  role="radiogroup"
                  aria-label={`Цвет тега «${tag.name}»`}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') return
                    refocus.current = { id: tag.id, target: 'swatch' }
                    setPaletteFor(null)
                  }}
                >
                  {PALETTE.map((p) => (
                    <button
                      key={p.color}
                      type="button"
                      role="radio"
                      aria-checked={tag.color.toLowerCase() === p.color}
                      aria-label={p.label}
                      title={p.label}
                      className={css.paletteItem}
                      style={{ background: p.color }}
                      onClick={() => {
                        setPaletteFor(null)
                        void run(recolorTag(tag.id, p.color))
                      }}
                    />
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {!readOnly &&
        (adding ? (
          <div className={css.adding}>
            <Plus size={16} aria-hidden />
            <InlineText
              value=""
              label="Название нового тега"
              placeholder="Название тега"
              maxLength={TAG_NAME_MAX}
              autoOpen
              draftKey={NEW_TAG_DRAFT}
              onClose={() => setAdding(false)}
              onSave={async (text) => tagNameError(text, view) ?? run(addTag(text, nextColor(view)), true)}
            />
          </div>
        ) : (
          <button type="button" className={css.add} onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden />
            Новый тег
          </button>
        ))}

      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Подтверждение удаления тега, который стоит на проектах. Escape — отмена. */
export function RemoveConfirm({ tag, count, onConfirm, onCancel }: { tag: Tag; count: number; onConfirm(): void; onCancel(): void }) {
  return (
    <div
      className={css.confirm}
      role="group"
      aria-label={`Удаление тега «${tag.name}»`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <p className={css.confirmText}>{removeWarning(count)}</p>
      <div className={css.confirmActions}>
        <button type="button" className={css.confirmDelete} autoFocus onClick={onConfirm}>
          Удалить тег
        </button>
        <button type="button" className={css.confirmCancel} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  )
}
