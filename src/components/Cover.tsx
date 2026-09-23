// Обложка проекта. Своя картинка появится на этапе 8; пока — генеративная заглушка в духе визора:
// тёмное стекло, свечение и узор линий. Всё выводится из slug, поэтому у проекта обложка всегда одна и та же.
import { useId } from 'react'
import css from './Cover.module.css'

/** FNV-1a: быстрый стабильный хэш строки. */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// Оттенки из палитры Тарталуги: фиолетовый, маджента, синий, сиреневый, бирюзовый.
const HUES = [258, 318, 226, 282, 190]
const PATTERNS = ['diagonal', 'scan', 'grid', 'rings'] as const

export interface CoverSpec {
  hue: number
  pattern: (typeof PATTERNS)[number]
  /** Центр свечения, доли ширины и высоты. */
  gx: number
  gy: number
  angle: number
}

export function coverSpec(slug: string): CoverSpec {
  const h = hash(slug)
  return {
    hue: HUES[h % HUES.length]!,
    pattern: PATTERNS[(h >>> 3) % PATTERNS.length]!,
    gx: 0.2 + ((h >>> 6) % 60) / 100,
    gy: 0.25 + ((h >>> 12) % 50) / 100,
    angle: [-35, -20, 20, 35][(h >>> 18) % 4]!,
  }
}

export function Cover({ slug, className }: { slug: string; className?: string }) {
  const s = coverSpec(slug)
  const id = useId().replace(/:/g, '')
  const glow = `hsl(${s.hue} 70% 62%)`
  const line = `hsl(${s.hue} 60% 70% / 0.22)`

  return (
    <svg className={`${css.cover} ${className ?? ''}`} viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <radialGradient id={`g${id}`} cx={s.gx} cy={s.gy} r="0.7">
          <stop offset="0" stopColor={glow} stopOpacity="0.75" />
          <stop offset="0.45" stopColor={glow} stopOpacity="0.18" />
          <stop offset="1" stopColor={glow} stopOpacity="0" />
        </radialGradient>
        <pattern id={`p${id}`} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform={`rotate(${s.pattern === 'diagonal' ? s.angle : 0})`}>
          {s.pattern === 'diagonal' && <line x1="0" y1="0" x2="0" y2="14" stroke={line} strokeWidth="1.2" />}
          {s.pattern === 'scan' && <line x1="0" y1="7" x2="14" y2="7" stroke={line} strokeWidth="1" />}
          {s.pattern === 'grid' && <circle cx="7" cy="7" r="1.1" fill={line} />}
          {s.pattern === 'rings' && <path d="M0 14 A14 14 0 0 1 14 0" fill="none" stroke={line} strokeWidth="1" />}
        </pattern>
      </defs>
      <rect width="320" height="180" fill={`hsl(${s.hue} 30% 9%)`} />
      <rect width="320" height="180" fill={`url(#g${id})`} />
      <rect width="320" height="180" fill={`url(#p${id})`} />
    </svg>
  )
}
