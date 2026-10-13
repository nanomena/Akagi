import type { ShowItem, ShowMeta } from '@/types'

// What a bot attaches to a reply for display: the `show` block of its `meta`.

/** The `show` block of a bot response's `meta`, or null if it carries none. */
export function pickShow(meta: unknown): ShowMeta | null {
  if (!meta || typeof meta !== 'object') return null
  const show = (meta as Record<string, unknown>).show
  if (!show || typeof show !== 'object') return null
  const items = (show as Record<string, unknown>).items
  if (!Array.isArray(items) || items.length === 0) return null
  return show as ShowMeta
}

/** A row is worth a line only if it has something to draw. */
export function hasContent(it: ShowItem): boolean {
  return Boolean(it.label || it.tiles || (it.pais && it.pais.length))
}

/**
 * Drawable rows of `show`, capped at `limit`.
 *
 * `limit` is how many rows there is room for. It is applied *after* the empty-row filter
 * so "top 3" always means three visible rows, not three candidates of which
 * some may render as nothing.
 */
export function visibleItems(show: ShowMeta | null, limit?: number): ShowItem[] {
  const items = show?.items.filter(hasContent) ?? []
  return limit === undefined ? items : items.slice(0, Math.max(0, limit))
}
