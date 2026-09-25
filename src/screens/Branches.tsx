// «Ветки» (ADR-007): черновики данных. Правки в ветке не трогают main, пока её не вольёшь.
// Слияние — только «ветка → main» и только если сервер проверил каждый изменённый файл; удаление требует свежего входа.
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ArrowSquareIn, GitBranch, GitMerge, GithubLogo, Plus, Trash } from '@phosphor-icons/react'
import { MAIN, useSession } from '../app/session'
import { useFreshAction } from '../app/useFreshAction'
import {
  ApiError,
  BRANCH_NAME,
  createBranch,
  deleteBranch,
  GITHUB_LOGIN_URL,
  listBranches,
  mergeBranch,
  problemFiles,
  type Branch,
} from '../lib/api'
import { useDraftText } from '../lib/drafts'
import { Link } from 'react-router'
import css from './Panel.module.css'
import own from './Branches.module.css'

type Outcome =
  | { kind: 'merged'; branch: string }
  | { kind: 'nothing'; branch: string }
  | { kind: 'invalid' | 'conflict'; branch: string; files: { path: string; error?: string }[] }

export function Branches() {
  const current = useSession((s) => s.branch)
  const switchBranch = useSession((s) => s.switchBranch)
  const branchDeleted = useSession((s) => s.branchDeleted)
  const refresh = useSession((s) => s.refresh)
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useDraftText('branches:new', 'Новая ветка: имя')
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const fresh = useFreshAction()
  const { busy } = fresh

  const load = useCallback(async () => {
    try {
      const { branches: list } = await listBranches()
      setBranches(list.filter((b) => !b.service))
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Не удалось загрузить ветки')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const nameOk = BRANCH_NAME.test(name) && name !== MAIN && name !== 'status'

  function create(e: FormEvent) {
    e.preventDefault()
    if (!nameOk) return
    setOutcome(null)
    void fresh.run(async () => {
      try {
        await createBranch(name)
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) throw new ApiError(409, 'conflict', `Ветка «${name}» уже есть`)
        throw err
      }
      setName('')
      await switchBranch(name)
      await load()
    })
  }

  function merge(branch: string) {
    if (!window.confirm(`Влить «${branch}» в main?\n\nСервер сначала проверит каждый изменённый файл. Если что-то не так, ничего не изменится.`)) return
    setOutcome(null)
    void fresh.run(async () => {
      try {
        const res = await mergeBranch(branch)
        setOutcome({ kind: res.merged ? 'merged' : 'nothing', branch })
        if (res.merged && useSession.getState().branch === MAIN) void refresh()
      } catch (err) {
        if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
          setOutcome({ kind: err.status === 409 ? 'conflict' : 'invalid', branch, files: problemFiles(err) })
          return
        }
        throw err
      }
      await load()
    })
  }

  function remove(branch: string, merged = false) {
    const warn = merged ? '' : '\n\nПравки, которые не влиты в main, пропадут.'
    if (!window.confirm(`Удалить ветку «${branch}»?${warn}`)) return
    void fresh.run(async () => {
      await deleteBranch(branch)
      setOutcome(null)
      await branchDeleted(branch)
      await load()
    })
  }

  const error = fresh.error ?? loadError

  return (
    <section className={css.page}>
      <nav className={`label ${own.crumb}`} aria-label="Путь">
        <Link to="/settings">Настройки</Link> · Данные
      </nav>
      <h1 className={css.title}>Ветки</h1>
      <p className={css.muted}>
        Ветка — черновик данных. Правки в ней не трогают main, пока ты её не вольёшь. Кэш и правки на устройстве у каждой ветки свои.
      </p>

      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
      {fresh.needGithub && (
        <div className={css.notice} role="alert">
          <p>Для этого нужно подтвердить вход ещё раз. Ключей пока нет, поэтому — через GitHub. После возврата повтори действие.</p>
          <a className={css.button} href={GITHUB_LOGIN_URL}>
            <GithubLogo size={18} aria-hidden /> Подтвердить через GitHub
          </a>
        </div>
      )}
      {outcome && <OutcomeNote outcome={outcome} busy={busy} onDelete={(b) => remove(b, true)} onOpenMain={() => void switchBranch(MAIN)} current={current} />}

      <form className={css.block} onSubmit={create}>
        <h2 className={css.h2}>
          <Plus size={20} aria-hidden /> Новая ветка от main
        </h2>
        <div className={own.createRow}>
          <input
            className={own.input}
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
            placeholder="например, redesign-2027"
            aria-label="Имя ветки"
            maxLength={40}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className={css.button} disabled={busy || !nameOk}>
            Создать и открыть
          </button>
        </div>
        <p className={css.meta}>латиница a–z, цифры и дефис, до 40 символов</p>
      </form>

      <div className={css.block}>
        <h2 className={css.h2}>
          <GitBranch size={20} aria-hidden /> Ветки репо данных
        </h2>
        {!branches && !loadError && <p className={css.muted}>Загружаю…</p>}
        <ul className={css.list}>
          {branches?.map((b) => {
            const open = b.name === current
            return (
              <li key={b.name} className={css.row}>
                <div>
                  <div>
                    <span className="mono">{b.name}</span>
                    {b.main && <span className={css.badge}>основная</span>}
                    {open && <span className={css.badge}>открыта</span>}
                  </div>
                  <div className={css.meta}>{b.head.slice(0, 7)}</div>
                </div>
                <div className={own.actions}>
                  {!open && (
                    <button type="button" className={css.ghost} onClick={() => void switchBranch(b.name)} disabled={busy}>
                      <ArrowSquareIn size={18} aria-hidden /> Открыть
                    </button>
                  )}
                  {!b.main && (
                    <>
                      <button type="button" className={css.ghost} onClick={() => merge(b.name)} disabled={busy}>
                        <GitMerge size={18} aria-hidden /> Влить в main
                      </button>
                      <button type="button" className={css.icon} onClick={() => remove(b.name)} disabled={busy} aria-label={`Удалить ветку ${b.name}`}>
                        <Trash size={18} aria-hidden />
                      </button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

function OutcomeNote(props: { outcome: Outcome; current: string; busy: boolean; onDelete(branch: string): void; onOpenMain(): void }) {
  const { outcome, current, busy } = props
  const b = `«${outcome.branch}»`
  if (outcome.kind === 'merged') {
    return (
      <div className={css.notice} data-tone="ok" role="status">
        <p>{b} влита в main.</p>
        <div className={own.actions}>
          {current !== MAIN && (
            <button type="button" className={css.ghost} onClick={props.onOpenMain} disabled={busy}>
              Открыть main
            </button>
          )}
          <button type="button" className={css.ghost} onClick={() => props.onDelete(outcome.branch)} disabled={busy}>
            <Trash size={18} aria-hidden /> Удалить ветку
          </button>
        </div>
      </div>
    )
  }
  if (outcome.kind === 'nothing') {
    return (
      <p className={css.notice} data-tone="ok" role="status">
        В {b} нет ничего нового относительно main — вливать нечего.
      </p>
    )
  }
  return (
    <div className={css.notice} role="alert">
      <p>
        {outcome.kind === 'conflict'
          ? `${b} конфликтует с main. Ничего не влито: разбери конфликт на GitHub или в самой ветке. Затронутые файлы:`
          : `В ${b} есть файлы, которые не проходят проверку. Ничего не влито. Исправь их в ветке:`}
      </p>
      {outcome.files.length > 0 && (
        <ul className={own.problems}>
          {outcome.files.map((f) => (
            <li key={f.path}>
              <span className="mono">{f.path}</span>
              {f.error && <span className={css.meta}> — {f.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
