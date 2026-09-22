import css from './Visor.module.css'

/** Логотип-визор: два светящихся «глаза» протогена. */
export function Visor({ size = 44 }: { size?: number }) {
  return (
    <span className={css.visor} style={{ width: size, height: size * 0.64 }} aria-hidden>
      <i className={css.eye} />
      <i className={`${css.eye} ${css.right}`} />
    </span>
  )
}
