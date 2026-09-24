// «Настройки» (макет 5-4a/5-4b): теги и порог заброшенности из settings.json, тема,
// вход в разделы «Ключи и входы» и «Ветки». Запись settings.json — через session.saveSettings.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, CaretRight, GitBranch, Minus, Plus, ShieldCheck } from '@phosphor-icons/react'
import { errorText, MAIN, useSession } from '../app/session'
import { buildLibrary } from '../data/projects'
import { TagEditor } from '../components/TagEditor'
import { ThemeSwitch } from '../components/ThemeSwitch'
import { clampDays, DAYS_MAX, DAYS_MIN, readSettings, setAbandonedDays } from '../components/TagEditor.model'
import css from './Settings.module.css'

export function Settings() {
  const files = useSession((s) => s.files)
  const branch = useSession((s) => s.branch)
  const unseen = useSession((s) => s.me?.unseenSecurityEvents ?? 0)
  const saveSettings = useSession((s) => s.saveSettings)
  const file = files.find((f) => f.path === 'settings.json')
  const settings = useMemo(() => readSettings(file), [file])
  const usage = useMemo(() => {
    const n: Record<string, number> = {}
    for (const p of buildLibrary(files, new Date()).projects) for (const t of p.data.tags ?? []) n[t] = (n[t] ?? 0) + 1
    return n
  }, [files])
  const readOnly = settings.problem !== null

  return (
    <section className={css.page}>
      <header className={css.head}>
        <Link to="/" className={css.back} aria-label="Назад">
          <ArrowLeft size={24} aria-hidden />
        </Link>
        <h1 className={css.title}>Настройки</h1>
      </header>

      {settings.problem && (
        <p className={css.problem} role="alert">
          {settings.problem}
        </p>
      )}

      <div className={css.columns}>
        <div className={css.column}>
          <section className={css.section} aria-labelledby="set-tags">
            <h2 id="set-tags" className={css.label}>
              Теги <span className={css.hint}>порядок здесь = порядок в карточках</span>
            </h2>
            <TagEditor tags={settings.tags} readOnly={readOnly} usage={usage} onChange={saveSettings} />
          </section>

          <section className={css.section} aria-labelledby="set-abandoned">
            <h2 id="set-abandoned" className={css.label}>
              Порог заброшенности
            </h2>
            <DaysStepper days={settings.days} readOnly={readOnly} onSave={(d) => saveSettings(setAbandonedDays(d))} />
          </section>
        </div>

        <div className={css.column}>
          <section className={css.section} aria-labelledby="set-view">
            <h2 id="set-view" className={css.label}>
              Вид
            </h2>
            <div className={css.theme}>
              <ThemeSwitch withLabels />
            </div>
          </section>

          <section className={css.section} aria-labelledby="set-security">
            <h2 id="set-security" className={css.label}>
              Безопасность
            </h2>
            <Link to="/settings/security" className={css.entry}>
              <ShieldCheck size={22} aria-hidden />
              <span className={css.entryText}>
                <span>Ключи и входы</span>
                <span className={css.entrySub}>ключи доступа, активные сессии, журнал входов</span>
              </span>
              {unseen > 0 && <span className={css.badge}>{unseen}</span>}
              <CaretRight size={18} aria-hidden />
            </Link>
          </section>

          <section className={css.section} aria-labelledby="set-data">
            <h2 id="set-data" className={css.label}>
              Данные
            </h2>
            <Link to="/settings/branches" className={css.entry}>
              <GitBranch size={22} aria-hidden />
              <span className={css.entryText}>
                <span>Ветки</span>
                <span className={css.entrySub}>черновики данных, слияние с main</span>
              </span>
              <span className={`mono ${css.branch}`} data-draft={branch !== MAIN || undefined}>
                {branch}
              </span>
              <CaretRight size={18} aria-hidden />
            </Link>
          </section>
        </div>
      </div>
    </section>
  )
}

/** −/число/+. Нажатия копятся на экране и уходят одной записью через полсекунды тишины. */
function DaysStepper({ days, readOnly, onSave }: { days: number; readOnly: boolean; onSave(days: number): Promise<void> }) {
  const [draft, setDraft] = useState<number | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Значение, которое ещё ждёт отправки, и свежий onSave — чтобы уход с экрана не терял последнее нажатие.
  const unsent = useRef<number | null>(null)
  const save = useRef(onSave)
  const shown = draft ?? days

  useEffect(() => {
    save.current = onSave
  })

  useEffect(
    () => () => {
      clearTimeout(timer.current)
      if (unsent.current !== null) save.current(unsent.current).catch(() => undefined)
    },
    [],
  )

  function schedule(next: number, delay = 500) {
    const value = clampDays(next)
    setDraft(value)
    setError(null)
    unsent.current = value
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      unsent.current = null
      save.current(value).then(
        () => setDraft((d) => (d === value ? null : d)),
        (e) => {
          setDraft(null)
          setError(errorText(e))
        },
      )
    }, delay)
  }

  function commitText() {
    if (text === null) return
    const n = Number.parseInt(text, 10)
    setText(null)
    if (Number.isFinite(n) && n !== shown) schedule(n, 0)
  }

  return (
    <div className={css.days}>
      <div className={css.stepper}>
        <button type="button" aria-label="Меньше на день" disabled={readOnly || shown <= DAYS_MIN} onClick={() => schedule(shown - 1)}>
          <Minus size={16} aria-hidden />
        </button>
        <input
          className="mono"
          inputMode="numeric"
          aria-label="Порог заброшенности, дней"
          disabled={readOnly}
          value={text ?? String(shown)}
          onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 3))}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText()
            if (e.key === 'Escape') setText(null)
          }}
        />
        <button type="button" aria-label="Больше на день" disabled={readOnly || shown >= DAYS_MAX} onClick={() => schedule(shown + 1)}>
          <Plus size={16} aria-hidden />
        </button>
      </div>
      <p className={css.daysText}>дней без записей в логе и коммитов — проект попадает в «Заброшенные»</p>
      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
