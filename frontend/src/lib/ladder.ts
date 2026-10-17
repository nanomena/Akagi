// Where the player stands on the platform's rank ladder, as the platform says
// it: the dock names the rank and shows its points, and works nothing out.

import { localized, tr } from '@/lib/i18n'

/** A place on a rank ladder: on Mahjong Soul `id` is the ladder (1 four-player,
 *  2 three-player), the rank and its star — 10303 is four-player, the third
 *  rank, third star — and `score` the points held toward the next star. */
export type Level = { id: number; score: number }
/** The player's own ranks as the platform last said them (at login, and after
 *  every game), and when. */
export type AccountLevels = { level: Level | null; level3: Level | null; at: string }

const RANK: Record<number, string> = localized({ 1: '初心', 2: '雀士', 3: '雀杰', 4: '雀豪', 5: '雀圣', 6: '魂天', 7: '魂天' })
const STAR: Record<number, string> = localized({ 1: '一', 2: '二', 3: '三' })
/** The points that make the next star, by rank and star: the number the client
 *  shows under its badge (雀杰二 1227/1400). Above 雀圣 the client counts otherwise. */
const CEILING: Record<number, readonly [number, number, number]> = {
  1: [20, 80, 200], 2: [600, 800, 1000], 3: [1200, 1400, 2000], 4: [2800, 3200, 3600], 5: [4000, 6000, 9000],
}

/** A rank as shown: its name (雀杰三), its points, and the points of the next
 *  star where there is one. */
export type Rung = { name: string; score: number; ceiling: number | null }

export function rungOf(level: Level): Rung {
  const rank = Math.floor(level.id / 100) % 100
  const star = level.id % 100
  const name = !RANK[rank] ? tr('段位 #{0}', level.id)
    : rank >= 6 ? tr('{0} Lv{1}', RANK[rank], star)
    : STAR[star] ? tr('{0}{1}', RANK[rank], STAR[star])
    : RANK[rank]
  return { name, score: level.score, ceiling: CEILING[rank]?.[star - 1] ?? null }
}
