// Адрес картинки обложки проекта (object URL) или null — тогда показывается генеративная заглушка.
import { useEffect, useMemo, useState } from 'react'
import { ownBannerPath, watchCover } from '../lib/coverImage'
import { useSession } from './session'

/** Поле проекта (cover или banner) из кэша открытой ветки. */
function useCoverField(slug: string, field: 'cover' | 'banner' = 'cover'): unknown {
  const text = useSession((s) => s.files.find((f) => f.path === `projects/${slug}.json`)?.text)
  return useMemo(() => {
    if (text === undefined) return null
    try {
      return (JSON.parse(text) as Record<string, unknown> | null)?.[field] ?? null
    } catch {
      return null
    }
  }, [text, field])
}

export function useCoverUrl(slug: string): string | null {
  const branch = useSession((s) => s.branch)
  const cover = useCoverField(slug)
  const index = useSession((s) => s.tree?.covers)
  const sha = typeof cover === 'string' ? index?.[cover] : undefined
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => watchCover(branch, slug, cover, index, setUrl),
    // index меняется при каждой сверке; перезагружаем только когда меняется sha (или поле/ветка).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  [branch, slug, cover, sha])

  return url
}

/** Адрес картинки шапки проекта или null — шапки нет, файл не читается или поле чужое (ADR-016). */
export function useBannerUrl(slug: string): string | null {
  const branch = useSession((s) => s.branch)
  const banner = useCoverField(slug, 'banner')
  const index = useSession((s) => s.tree?.covers)
  const sha = typeof banner === 'string' ? index?.[banner] : undefined
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => watchCover(branch, slug, banner, index, setUrl, ownBannerPath),
    // как в useCoverUrl: перезагружаем только при смене sha, поля или ветки.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  [branch, slug, banner, sha])

  return url
}
