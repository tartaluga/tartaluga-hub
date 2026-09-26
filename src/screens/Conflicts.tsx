// «Входящие конфликты» (ADR-004 шаг 5, ADR-010 §2, макет 5-6a/5-6b). Постоянный раздел, а не окно посреди синхронизации:
// каждое спорное место — проект, поле, «моя версия» и «версия из репо», выбор. Длинный текст — выбор по кускам.
// Всё из репо показывается только как текст.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSession, errorText, MAIN } from '../app/session'
import type { StoredConflict } from '../lib/localdb'
import type { MergeConflict } from '../data/merge'
import { isLongText, sideText, type ConflictPick } from '../data/conflicts'
import { allChosen, buildText, diff3Chunks, initialChoices, type Side } from '../data/textMerge'
import { plural } from '../lib/plural'
import css from './Conflicts.module.css'

/** Сколько спорных мест в записи: у записи без мест (отказ, удаление) — одно. */
export const conflictCount = (list: readonly StoredConflict[]) => list.reduce((n, c) => n + (c.items.length || 1), 0)

export function Conflicts() {
  const conflicts = useSession((s) => s.conflicts)
  const queued = useSession((s) => s.queued)
  const resolve = useSession((s) => s.resolveConflict)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chunked, setChunked] = useState<{ rec: StoredConflict; index: number } | null>(null)
  const total = conflictCount(conflicts)
  const withItems = conflicts.filter((c) => c.items.length && !c.refused && !c.deleted)

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const pick = (rec: StoredConflict, index: number, p: ConflictPick) => run(() => resolve(rec.branch, rec.path, [{ index, pick: p }]))
  const pickAll = (p: 'mine' | 'repo') =>
    run(async () => {
      for (const rec of withItems) await resolve(rec.branch, rec.path, rec.items.map((_, index) => ({ index, pick: p })))
    })

  return (
    <section className={css.page}>
      <header className={css.head}>
        <div>
          <div className={`label ${css.kicker}`}>{total ? `${total} ${plural(total, 'конфликт', 'конфликта', 'конфликтов')}` : 'конфликтов нет'}</div>
          <h1 className={css.title}>Входящие конфликты</h1>
          <p className={css.lead}>Одно и то же поле изменили на двух устройствах до синхронизации. Выбери, какую версию оставить.</p>
        </div>
        {withItems.length > 0 && (
          <div className={css.bulk}>
            <button type="button" className={css.button} onClick={() => void pickAll('mine')} disabled={busy}>
              Все мои
            </button>
            <button type="button" className={css.button} onClick={() => void pickAll('repo')} disabled={busy}>
              Все из репо
            </button>
          </div>
        )}
      </header>

      {queued > 0 && (
        <p className={`label ${css.pending}`}>
          <span className={css.dot} aria-hidden /> {queued} {plural(queued, 'правка ждёт', 'правки ждут', 'правок ждут')} отправки
        </p>
      )}
      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
      {!conflicts.length && <p className={css.empty}>Всё записано — выбирать нечего.</p>}

      {conflicts.map((rec) =>
        rec.refused ? (
          <Card key={`${rec.branch}\n${rec.path}`} rec={rec} what="правка не записана">
            <p className={css.reason}>{rec.refused.reason}</p>
            <details className={css.details}>
              <summary>Моя версия файла</summary>
              <pre className={css.pre}>{rec.refused.mine}</pre>
            </details>
            <div className={css.actions}>
              <button type="button" className={css.button} onClick={() => void pick(rec, 0, 'repo')} disabled={busy}>
                Взять из репо
              </button>
            </div>
          </Card>
        ) : rec.deleted ? (
          <Card key={`${rec.branch}\n${rec.path}`} rec={rec} what="проект удалён в репо">
            <div className={css.sides}>
              <Version head="моя версия · это устройство" text="проект с моей правкой" mine>
                <button type="button" className={css.button} onClick={() => void pick(rec, 0, 'mine')} disabled={busy}>
                  Вернуть проект
                </button>
              </Version>
              <Version head="версия из репо" text="удалён">
                <button type="button" className={css.button} onClick={() => void pick(rec, 0, 'repo')} disabled={busy}>
                  Согласиться с удалением
                </button>
              </Version>
            </div>
          </Card>
        ) : (
          rec.items.map((item, index) => (
            <Card key={`${rec.branch}\n${rec.path}\n${item.path.join('\n')}`} rec={rec} what={`${item.kind === 'field' ? 'поле · ' : ''}${rec.labels[index] ?? item.path.join('.')}`}>
              <div className={css.sides}>
                <Version head="моя версия · это устройство" text={sideText(item, 'local')} mine>
                  <button type="button" className={css.button} onClick={() => void pick(rec, index, 'mine')} disabled={busy}>
                    Оставить мою
                  </button>
                </Version>
                <Version head="версия из репо" text={sideText(item, 'remote')}>
                  <button type="button" className={css.button} onClick={() => void pick(rec, index, 'repo')} disabled={busy}>
                    Взять из репо
                  </button>
                </Version>
              </div>
              {isLongText(item) && (
                <button type="button" className={css.link} onClick={() => setChunked({ rec, index })} disabled={busy}>
                  Выбрать по кускам
                </button>
              )}
            </Card>
          ))
        ),
      )}

      {chunked && chunked.rec.items[chunked.index] && (
        <ChunkDialog
          item={chunked.rec.items[chunked.index]!}
          label={chunked.rec.labels[chunked.index] ?? ''}
          onClose={() => setChunked(null)}
          onApply={(text) => {
            const { rec, index } = chunked
            setChunked(null)
            void pick(rec, index, { text })
          }}
        />
      )}
    </section>
  )
}

function Card({ rec, what, children }: { rec: StoredConflict; what: string; children: ReactNode }) {
  return (
    <article className={css.card}>
      <div className={css.cardHead}>
        <strong className={css.project}>{rec.title}</strong>
        <span className="label">
          {what}
          {rec.branch !== MAIN && ` · ветка ${rec.branch}`}
        </span>
      </div>
      {children}
    </article>
  )
}

function Version({ head, text, mine, children }: { head: string; text: string; mine?: boolean; children: ReactNode }) {
  return (
    <div className={mine ? `${css.side} ${css.mine}` : css.side}>
      <div className="label">{head}</div>
      <p className={css.value}>{text}</p>
      {children}
    </div>
  )
}

const CHUNK_KIND: Record<string, string> = { local: 'изменено у тебя', remote: 'изменено в репо', both: 'изменено с обеих сторон' }

/** Окно выбора кусков текста (ADR-010 §2): изменённое с одной стороны выбрано заранее, с обеих — выбрать обязательно. */
function ChunkDialog({ item, label, onApply, onClose }: { item: MergeConflict; label: string; onApply: (text: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const chunks = useMemo(() => diff3Chunks(str(item.base), str(item.local), str(item.remote)), [item])
  const [choices, setChoices] = useState<Array<Side | null>>(() => initialChoices(chunks))
  const result = buildText(chunks, choices)

  useEffect(() => {
    const d = ref.current
    if (d && !d.open && typeof d.showModal === 'function') d.showModal()
  }, [])

  const choose = (i: number, side: Side) => setChoices((cur) => cur.map((c, j) => (j === i ? side : c)))

  return (
    <dialog ref={ref} className={css.dialog} onClose={onClose} aria-labelledby="chunks-title">
      <div className={css.dialogBody}>
        <div className={css.dialogHead}>
          <h2 id="chunks-title" className={css.dialogTitle}>
            Выбор по кускам
          </h2>
          <span className="label">{label}</span>
        </div>
        <ol className={css.chunks}>
          {chunks.map((c, i) =>
            c.kind !== 'same' ? (
              <li key={i} className={css.chunk} data-kind={c.kind}>
                <div className={`label ${c.kind === 'both' ? css.hot : ''}`}>{CHUNK_KIND[c.kind]}</div>
                <div className={css.chunkSides} role="radiogroup" aria-label={`Кусок ${i + 1}`}>
                  {(['local', 'remote'] as const).map((side) => (
                    <button
                      key={side}
                      type="button"
                      role="radio"
                      aria-checked={choices[i] === side}
                      className={css.chunkPick}
                      onClick={() => choose(i, side)}
                    >
                      <span className="label">{side === 'local' ? 'моя' : 'из репо'}</span>
                      <pre className={css.pre}>{c[side] || '— пусто'}</pre>
                    </button>
                  ))}
                </div>
              </li>
            ) : (
              <li key={i} className={css.same}>
                <pre className={css.pre}>{c.local}</pre>
              </li>
            ),
          )}
        </ol>
        <div className="label">итог</div>
        <pre className={`${css.pre} ${css.result}`}>{result ?? 'Выбери все куски, изменённые с обеих сторон.'}</pre>
        <div className={css.actions}>
          <button type="button" className={css.ghost} onClick={onClose}>
            Отмена
          </button>
          <button type="button" className={css.primary} disabled={!allChosen(chunks, choices) || result === null} onClick={() => result !== null && onApply(result)}>
            Применить
          </button>
        </div>
      </div>
    </dialog>
  )
}
