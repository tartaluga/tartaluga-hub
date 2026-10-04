// Адрес картинки обложки проекта (object URL) или null — тогда показывается генеративная заглушка.
import { useEffect, useMemo, useState } from 'react'
import { watchCover } from '../lib/coverImage'
import { useSession } from './session'

/** Поле cover проекта из кэша открытой ветки. */
function useCoverField(slug: string): unknown {
  const text = useSession((s) => s.files.find((f) => f.path === `projects/${slug}.json`)?.text)
  return useMemo(() => {
    if (text === undefined) return null
    try {
      return (JSON.parse(text) as { cover?: unknown } | null)?.cover ?? null
    } catch {
      return null
    }
  }, [text])
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
