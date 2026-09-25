// Графики экрана «Статистика» — свой SVG без библиотек. Цвета только из токенов через CSS (data-tone / data-level),
// размеры — атрибутами SVG, поэтому CSP без unsafe-inline не мешает.
import type { StatsDay } from '../data/stats'
import { plural } from '../lib/plural'
import css from './StatsCharts.module.css'

const CELL = 20
const GAP = 6

/** Тепловая карта: столбец — неделя с понедельника, строка — день недели. */
export function StatsHeatmap({ weeks, label }: { weeks: StatsDay[][]; label: string }) {
  const width = Math.max(1, weeks.length) * (CELL + GAP) - GAP
  const height = 7 * (CELL + GAP) - GAP
  return (
    <svg className={css.heat} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {weeks.map((w, x) =>
        w.map((d, y) => (
          <rect
            key={d.date}
            x={x * (CELL + GAP)}
            y={y * (CELL + GAP)}
            width={CELL}
            height={CELL}
            rx={4}
            data-level={d.level}
            data-out={d.out || undefined}
          >
            {!d.out && <title>{`${d.date.slice(8)}.${d.date.slice(5, 7)} · ${d.count} ${plural(d.count, 'запись', 'записи', 'записей')}`}</title>}
          </rect>
        )),
      )}
    </svg>
  )
}

/** Подпись к тепловой карте: «меньше ▪▪▪▪▪ больше». */
export function StatsHeatLegend() {
  const size = 12
  const gap = 5
  return (
    <p className={css.heatLegend}>
      меньше
      <svg width={5 * (size + gap) - gap} height={size} aria-hidden>
        {[0, 1, 2, 3, 4].map((l) => (
          <rect key={l} x={l * (size + gap)} width={size} height={size} rx={3} data-level={l} />
        ))}
      </svg>
      больше
    </p>
  )
}

export interface StackSegment {
  key: string
  value: number
  /** Цвет сегмента: статус проекта (idea, active…) или итог срока (onTime, moved, missed). */
  tone: string
}

/** Долевая полоса: сегменты по значениям, пустые пропускаются; без данных — только дорожка. */
export function StatsStackBar({ segments }: { segments: StackSegment[] }) {
  const live = segments.filter((s) => s.value > 0)
  const total = live.reduce((a, s) => a + s.value, 0)
  const gap = 0.6
  const room = 100 - gap * Math.max(0, live.length - 1)
  let x = 0
  return (
    <svg className={css.stack} width="100%" height={6} aria-hidden>
      {total === 0 ? (
        <rect className={css.track} width="100%" height={6} rx={3} />
      ) : (
        live.map((s) => {
          const w = (s.value / total) * room
          const rect = <rect key={s.key} x={`${x}%`} width={`${w}%`} height={6} rx={3} data-tone={s.tone} />
          x += w + gap
          return rect
        })
      )}
    </svg>
  )
}

/** Полоса «сколько от максимума» в списке активности. */
export function StatsMeter({ share }: { share: number }) {
  const w = Math.max(0, Math.min(1, share)) * 100
  return (
    <svg className={css.meter} width="100%" height={6} aria-hidden>
      <rect className={css.track} width="100%" height={6} rx={3} />
      {w > 0 && <rect className={css.fill} width={`${w}%`} height={6} rx={3} />}
    </svg>
  )
}
