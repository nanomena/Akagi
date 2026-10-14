import { localized, tr } from '@/lib/i18n'
// The games on record (`get_history`) and what the statistics tab works out
// from them. The core stores one line a game: how it ended for us, a block of
// counters for the hands in it, and — from the builds that keep them — what it
// did to our rank points and which yaku our wins had.

/** A game as the core recorded it. Only what the tab reads is named. */
export type GameRecord = {
  id: string
  ended_at: string
  platform: string
  num_players: number
  our_seat: number | null
  final_scores: number[]
  our_rank: number | null
  /** Per-hand counters, from our seat: `round`, `agari`, `houjuu`, `riichi`, … */
  stats: Record<string, number>
  match_info?: { platform: string; mode_id?: number; room_id?: number; contest_uid?: number } | null
  /** `null` or missing on records from before it was kept. */
  our_rank_points?: number | null
  /** Yaku id → how many of our winning hands this game had it. */
  yaku?: Record<string, number>
}

// ----------------------------------------------------------------- rooms ----

/** Mahjong Soul's ranked match modes by room, from the game's own table:
 *  three four-player modes a room below Throne, two three-player ones. */
const TIER_OF_MODE: Record<number, Room> = {
  1: 'bronze', 2: 'bronze', 3: 'bronze', 4: 'silver', 5: 'silver', 6: 'silver', 7: 'gold', 8: 'gold', 9: 'gold',
  10: 'jade', 11: 'jade', 12: 'jade', 15: 'throne', 16: 'throne',
  17: 'bronze', 18: 'bronze', 19: 'silver', 20: 'silver', 21: 'gold', 22: 'gold', 23: 'jade', 24: 'jade', 25: 'throne', 26: 'throne',
}
export type Room = 'bronze' | 'silver' | 'gold' | 'jade' | 'throne' | 'other'
export const ROOMS: Room[] = ['bronze', 'silver', 'gold', 'jade', 'throne', 'other']
export const ROOM_NAME: Record<Room, string> = localized({ bronze: '铜之间', silver: '银之间', gold: '金之间', jade: '玉之间', throne: '王座之间', other: '友人场及其他' })

/** The room a game was played in. Anything that is not a ranked room this
 *  table knows — a friends' table, a contest, an event, another platform — is
 *  `other`: better one honest heap than a wrong name. */
export function roomOf(r: GameRecord): Room {
  const mode = r.match_info?.platform === 'majsoul' ? r.match_info.mode_id : undefined
  return (mode != null && TIER_OF_MODE[mode]) || 'other'
}

// ------------------------------------------------------------------ yaku ----

/** Mahjong Soul's ids for yaku. An id that is not here is shown by its number. */
const YAKU_NAME: Record<number, string> = localized({
  1: '门前清自摸和', 2: '立直', 3: '抢杠', 4: '岭上开花', 5: '海底摸月', 6: '河底捞鱼', 7: '役牌 白', 8: '役牌 发', 9: '役牌 中',
  10: '役牌 自风', 11: '役牌 场风', 12: '断幺九', 13: '一杯口', 14: '平和', 15: '混全带幺九', 16: '一气通贯', 17: '三色同顺',
  18: '两立直', 19: '三色同刻', 20: '三杠子', 21: '对对和', 22: '三暗刻', 23: '小三元', 24: '混老头', 25: '七对子',
  26: '纯全带幺九', 27: '混一色', 28: '二杯口', 29: '清一色', 30: '一发', 31: '宝牌', 32: '红宝牌', 33: '里宝牌', 34: '拔北宝牌',
  35: '天和', 36: '地和', 37: '大三元', 38: '四暗刻', 39: '字一色', 40: '绿一色', 41: '清老头', 42: '国士无双', 43: '小四喜',
  44: '四杠子', 45: '九莲宝灯', 46: '八连庄', 47: '纯正九莲宝灯', 48: '四暗刻单骑', 49: '国士无双十三面', 50: '大四喜',
})
export const yakuName = (id: number): string => YAKU_NAME[id] ?? tr('役 #{0}', id)

// ----------------------------------------------------------------- totals ----

export type Totals = {
  games: number
  /** Hands played. */
  hands: number
  /** Games finished in each place, first to last. */
  places: number[]
  averagePlace: number | null
  /** Rank points after each game that reported them, oldest first, summed as they go. */
  points: number[]
  /** Games that reported rank points. */
  pointGames: number
  /** The counters of every game added up. */
  sum: Record<string, number>
  /** Yaku by how many of our wins had it, most first. */
  yaku: Array<{ id: number; wins: number }>
  /** Our wins in the games that say how a hand was scored. */
  scoredWins: number
}

/** Add up `records`, which are taken in the order given (oldest first, as the core lists them). */
export function totalsOf(records: GameRecord[]): Totals {
  const players = records.some(r => r.num_players === 4) || records.length === 0 ? 4 : 3
  const places = new Array<number>(players).fill(0)
  const sum: Record<string, number> = {}
  const yaku = new Map<number, number>()
  const points: number[] = []
  let placed = 0, placeSum = 0, scoredWins = 0
  for (const r of records) {
    for (const [key, value] of Object.entries(r.stats)) sum[key] = (sum[key] ?? 0) + value
    if (r.our_rank != null && r.our_rank >= 1 && r.our_rank <= players) { places[r.our_rank - 1] += 1; placed += 1; placeSum += r.our_rank }
    if (r.our_rank_points != null) points.push((points.at(-1) ?? 0) + r.our_rank_points)
    const had = Object.entries(r.yaku ?? {})
    if (had.length > 0) scoredWins += r.stats.agari ?? 0
    for (const [id, wins] of had) yaku.set(Number(id), (yaku.get(Number(id)) ?? 0) + wins)
  }
  return {
    games: records.length, hands: sum.round ?? 0, places, averagePlace: placed ? placeSum / placed : null,
    points, pointGames: points.length, sum,
    yaku: [...yaku].map(([id, wins]) => ({ id, wins })).sort((a, b) => b.wins - a.wins || a.id - b.id),
    scoredWins,
  }
}

/** One line of the figures column: a name and a value already written out. */
export type Figure = { name: string; value: string; note?: string }

const percent = (part: number, whole: number): string => (whole > 0 ? `${(100 * part / whole).toFixed(1)}%` : '—')
const average = (total: number, count: number, digits = 0): string =>
  count > 0 ? (total / count).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—'

/** The figures a riichi player looks for first, in the order they are usually read. */
export function figuresOf(t: Totals): Figure[] {
  const s = (key: string) => t.sum[key] ?? 0
  return [
    { name: tr('和了率'), value: percent(s('agari'), t.hands), note: tr('和了的局数 ÷ 总局数') },
    { name: tr('放铳率'), value: percent(s('houjuu'), t.hands), note: tr('放铳的局数 ÷ 总局数') },
    { name: tr('立直率'), value: percent(s('riichi'), t.hands) },
    { name: tr('副露率'), value: percent(s('fuuro'), t.hands) },
    { name: tr('流局率'), value: percent(s('ryukyoku'), t.hands) },
    { name: tr('平均和了点'), value: average(s('agari_point_oya') + s('agari_point_ko'), s('agari')) },
    { name: tr('平均放铳点'), value: average(s('houjuu_point_to_oya') + s('houjuu_point_to_ko'), s('houjuu')) },
    { name: tr('和了巡数'), value: average(s('agari_jun'), s('agari'), 1) },
    { name: tr('立直巡数'), value: average(s('riichi_jun'), s('riichi'), 1) },
    { name: tr('立直和了率'), value: percent(s('riichi_agari'), s('riichi')), note: tr('立直后和了 ÷ 立直次数') },
    { name: tr('立直放铳率'), value: percent(s('riichi_houjuu'), s('riichi')), note: tr('立直后放铳 ÷ 立直次数') },
    { name: tr('副露和了率'), value: percent(s('fuuro_agari'), s('fuuro')), note: tr('副露后和了 ÷ 副露的局数') },
    { name: tr('副露放铳率'), value: percent(s('fuuro_houjuu'), s('fuuro')), note: tr('副露后放铳 ÷ 副露的局数') },
    { name: tr('默听和了'), value: percent(s('dama_agari'), s('agari')), note: tr('门前不立直的和了 ÷ 和了次数') },
    { name: tr('追立'), value: tr('{0} 次', s('chasing_riichi')), note: tr('在别家立直之后宣告的立直') },
    { name: tr('役满'), value: tr('{0} 次', s('yakuman')) },
    { name: tr('总局数'), value: tr('{0} 局', t.hands) },
  ]
}
