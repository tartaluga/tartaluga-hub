// Шапка проекта вверху карточки (G4.6, ADR-016): полоса 5:2 по ширине колонки, без обрезки при показе.
// Нет шапки или файл не читается — рисуются children (обложка).
import type { ReactNode } from 'react'
import { useBannerUrl } from '../app/useCoverUrl'
import css from './Banner.module.css'

export function Banner({ slug, muted = false, children = null }: { slug: string; muted?: boolean; children?: ReactNode }) {
  const url = useBannerUrl(slug)
  if (!url) return <>{children}</>
  return <img className={`${css.banner} ${muted ? css.muted : ''}`} src={url} alt="" data-testid="project-banner" />
}
