import type { ReactNode } from 'react'
import css from './ScreenStub.module.css'

/** Временная заглушка экрана до его реализации (фазы C–F). */
export function ScreenStub({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section>
      <div className="label">{eyebrow}</div>
      <h1 className={css.title}>{title}</h1>
      <p className={css.text}>{children}</p>
    </section>
  )
}
