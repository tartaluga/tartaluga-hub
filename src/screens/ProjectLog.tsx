// Лог проекта в карточке (C5): запись за два касания с телефона — поле уже с выбранным видом, «Записать».
// Вид запоминается на устройстве: подряд обычно пишут одно и то же («сделано», «сделано»…).
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { PaperPlaneRight, X } from '@phosphor-icons/react'
import { LOG_KIND_LABEL, LOG_KINDS, LOG_TEXT_MAX, logKindLabel, logWhen, newLogEntry, sortedLog, type LogKind, type ProjectPatch } from '../data/editProject'
import type { LogEntry } from '../schema/types'
import css from './ProjectLog.module.css'

const KIND_KEY = 'log.kind'
// Лента длинная у живых проектов: сначала показываем свежие, остальное по кнопке.
const PAGE = 20

function readKind(): LogKind {
  try {
    const k = localStorage.getItem(KIND_KEY)
    return (LOG_KINDS as readonly string[]).includes(k ?? '') ? (k as LogKind) : 'done'
  } catch {
    return 'done'
  }
}

interface Props {
  log: LogEntry[]
  readOnly: boolean
  save(patch: ProjectPatch): Promise<string | null>
}

export function ProjectLog({ log, readOnly, save }: Props) {
  const [kind, setKind] = useState<LogKind>(readKind)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)
  const feed = sortedLog(log)
  const now = new Date()

  function pick(k: LogKind) {
    setKind(k)
    try {
      localStorage.setItem(KIND_KEY, k)
    } catch {
      /* без хранилища вид просто не запомнится */
    }
  }

  async function add(e?: FormEvent) {
    e?.preventDefault()
    if (!text.trim()) return
    const entry = newLogEntry(kind, text)
    // Поле очищаем сразу: запись уже видна в ленте; если не сохранилась — текст вернётся в поле.
    setText('')
    setError(null)
    const err = await save({ logAdd: [entry] })
    if (err) {
      setError(err)
      setText((cur) => cur || entry.text)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter — записать, Shift+Enter — новая строка (на телефоне Enter клавиатуры тоже пишет запись).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void add()
    }
  }

  async function remove(entry: LogEntry) {
    if (!window.confirm(`Удалить запись «${entry.text.slice(0, 60)}${entry.text.length > 60 ? '…' : ''}»?`)) return
    setError(null)
    const err = await save({ logRemove: [entry.id] })
    if (err) setError(err)
  }

  return (
    <section className={css.section}>
      <h2 className={css.title}>Лог</h2>
      {!readOnly && (
        <form className={css.composer} onSubmit={add}>
          <div className={css.kinds} role="radiogroup" aria-label="Вид записи">
            {LOG_KINDS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} data-kind={k} onClick={() => pick(k)}>
                {LOG_KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div className={css.inputRow}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              maxLength={LOG_TEXT_MAX}
              rows={1}
              placeholder="Что сделано, что решено, о чём подумал…"
              aria-label="Текст записи"
            />
            <button type="submit" className={css.send} disabled={!text.trim()} aria-label="Записать">
              <PaperPlaneRight size={18} aria-hidden />
            </button>
          </div>
          {error && (
            <p className={css.error} role="alert">
              {error}
            </p>
          )}
        </form>
      )}

      {feed.length === 0 ? (
        <p className={css.muted}>Записей пока нет. Лог — это то, по чему видно, что проект живой.</p>
      ) : (
        <ol className={css.feed}>
          {feed.slice(0, shown).map((e) => (
            <li key={e.id} className={css.entry}>
              <div className={css.meta}>
                <span className={css.kind} data-kind={e.kind}>
                  {logKindLabel(e.kind)}
                </span>
                <time dateTime={e.at}>{logWhen(e.at, now)}</time>
                {!readOnly && (
                  <button type="button" className={css.remove} onClick={() => void remove(e)} aria-label="Удалить запись">
                    <X size={14} aria-hidden />
                  </button>
                )}
              </div>
              <p className={css.text}>{e.text}</p>
            </li>
          ))}
        </ol>
      )}
      {feed.length > shown && (
        <button type="button" className={css.more} onClick={() => setShown((n) => n + PAGE)}>
          Показать ещё {Math.min(PAGE, feed.length - shown)} из {feed.length - shown}
        </button>
      )}
    </section>
  )
}
