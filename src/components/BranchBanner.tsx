// Плашка «ветка: …» (ADR-007): на любой ветке, кроме main, видна всегда — иначе легко забыть, что правишь черновик.
import { Link } from 'react-router'
import { CaretRight, GitBranch, X } from '@phosphor-icons/react'
import { MAIN, useSession } from '../app/session'
import css from './BranchBanner.module.css'

export function BranchBanner() {
  const branch = useSession((s) => s.branch)
  const notice = useSession((s) => s.branchNotice)
  const dismiss = useSession((s) => s.dismissBranchNotice)

  return (
    <>
      {branch !== MAIN && (
        <Link to="/branches" className={css.banner} data-draft title="Ветки репо данных">
          <GitBranch size={20} aria-hidden />
          <span>
            ветка: <b className="mono">{branch}</b>
            <span className={css.hint}> — правки идут в неё, не в main</span>
          </span>
          <CaretRight size={16} aria-hidden className={css.caret} />
        </Link>
      )}
      {notice && (
        <div className={css.banner} data-tone="info" role="status">
          <span>{notice}</span>
          <button type="button" className={css.close} onClick={dismiss} aria-label="Закрыть">
            <X size={16} aria-hidden />
          </button>
        </div>
      )}
    </>
  )
}
