// @ts-check
// What the game is doing, for pages a streaming program shows beside it: the
// round and the scores, how each hand of this game ended, the player's own
// ranks, when this run of the app began, and the games on record. Nothing about the bot — no decision, no candidate, nothing a bot or
// its service said of itself, not even whether autoplay is on. The core's
// monitor snapshot and its game records are cut down here to what anyone
// watching the table could see, field by field: a field the core adds later is
// left out until it is named here.

/** The shape's version. It goes up when a field changes meaning or goes away; added fields do not. */
export const FEED_VERSION = 1

/** Of a record's match, what names the room; not the ids that lead to a replay. */
const MATCH_FIELDS = /** @type {Record<string, string[]>} */ ({
  majsoul: ['mode_id', 'room_id', 'contest_uid'],
  tenhou: ['go_type', 'lobby'],
  riichi_city: ['classify_id', 'stage_type', 'game_play'],
})

const RECORD_FIELDS = ['id', 'started_at', 'ended_at', 'platform', 'num_players', 'kyoku_mode', 'names', 'our_seat',
  'final_scores', 'final_ranks', 'our_rank', 'our_delta', 'our_rank_points', 'our_level', 'stats', 'yaku']

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
/** @param {unknown} value @returns {any[]} */
const list = value => (Array.isArray(value) ? value : [])
/** @param {unknown} value */
const strings = value => list(value).filter(item => typeof item === 'string')
/** @param {unknown} value */
const numbers = value => list(value).filter(item => typeof item === 'number')
/** @param {unknown} value */
const number = value => (typeof value === 'number' ? value : null)
/** @param {unknown} value */
const text = value => (typeof value === 'string' ? value : null)

/** @param {Record<string, any>} from @param {string[]} names */
function pick(from, names) {
  /** @type {Record<string, unknown>} */
  const kept = {}
  for (const name of names) if (Object.hasOwn(from, name)) kept[name] = from[name]
  return kept
}

/** A place on a rank ladder, as the platform gives it: `{id, score}`. */
function publicLevel(/** @type {unknown} */ level) {
  if (!isObject(level) || typeof level.id !== 'number' || typeof level.score !== 'number') return null
  return { id: level.id, score: level.score }
}

/**
 * The player's own ranks, four- and three-player, as the platform last said
 * them, and when: the games that ended before are counted in them. Not who
 * the player is.
 */
function publicAccount(/** @type {unknown} */ account) {
  if (!isObject(account)) return null
  return { level: publicLevel(account.level), level3: publicLevel(account.level3), at: text(account.at) }
}

/** How a hand ended, and the hands that were shown when it did. */
function publicRound(/** @type {unknown} */ result) {
  if (!isObject(result)) return null
  return {
    kind: text(result.kind),
    scores: Array.isArray(result.scores) ? numbers(result.scores) : null,
    deltas: Array.isArray(result.deltas) ? numbers(result.deltas) : null,
    hands: list(result.hands).filter(isObject).map(hand => ({
      seat: number(hand.seat),
      tiles: strings(hand.tiles),
      winning_tile: text(hand.winning_tile),
      target: number(hand.target),
      ura_markers: strings(hand.ura_markers),
    })),
  }
}

/**
 * The table as anyone watching it sees it, from the core's monitor snapshot.
 * @param {unknown} snapshot
 * @param {string | null} [startedAt] when this run of the app began (ISO 8601)
 */
export function publicState(snapshot, startedAt = null) {
  if (!isObject(snapshot)) return null
  const game = isObject(snapshot.game) ? snapshot.game : null
  const players = game ? list(game.players).filter(isObject) : []
  return {
    version: FEED_VERSION,
    names: strings(snapshot.names),
    our_seat: number(game?.our_seat),
    game: game && {
      bakaze: text(game.bakaze),
      kyoku: number(game.kyoku),
      honba: number(game.honba),
      kyotaku: number(game.kyotaku),
      oya: number(game.oya),
      num_players: number(game.num_players) ?? players.length,
      scores: players.map(player => number(player.score)),
      riichi: players.map(player => player.riichi_declared === true),
      dora_markers: strings(game.dora_markers),
    },
    round_ended: snapshot.round_ended === true,
    game_ended: snapshot.game_ended === true,
    hands: list(snapshot.hands).filter(isObject).map(hand => ({
      round: number(hand.round),
      bakaze: text(hand.bakaze),
      kyoku: number(hand.kyoku),
      honba: number(hand.honba),
      result: publicRound(hand.result),
    })),
    account: publicAccount(snapshot.account),
    started_at: startedAt,
  }
}

/**
 * A game on record, without where its log is kept or the ids that lead to its replay.
 * @param {unknown} record
 * @returns {Record<string, unknown> | null}
 */
export function publicResult(record) {
  if (!isObject(record)) return null
  const match = isObject(record.match_info) ? record.match_info : null
  return {
    ...pick(record, RECORD_FIELDS),
    match_info: match && pick(match, ['platform', ...(MATCH_FIELDS[match.platform] ?? [])]),
  }
}

/** @typedef {NonNullable<ReturnType<typeof publicState>>} PublicState */
/** @typedef {NonNullable<ReturnType<typeof publicResult>>} PublicResult */
/** @typedef {(kind: 'state' | 'results', value: unknown) => void} Listener */

/**
 * The feed: the table as it is now, and the games on record, with word to
 * whoever listens when either changes. The records are read only once someone
 * asks for them, and again when a game ends or begins.
 */
export class Feed {
  /** @type {PublicState | null} */
  #state = null
  #stateText = 'null'
  /** @type {PublicResult[] | null} */
  #results = null
  #resultsText = ''
  /** @type {Promise<PublicResult[]> | null} */
  #reading = null
  /** @type {Set<Listener>} */
  #listeners = new Set()
  /** @type {Set<NodeJS.Timeout>} */
  #timers = new Set()
  #read
  #again
  #log
  #startedAt

  /**
   * @param {{ readResults: () => Promise<unknown>, again?: number[], log?: (message: string) => void, startedAt?: Date }} options
   *   `readResults` gives the games on record as the core keeps them; `again`
   *   is how long after a game ends or begins they are read again (a game that
   *   has just ended is written a moment after its last event); `startedAt` is
   *   when this run of the app began, by default when the feed is made (the
   *   app makes it as it starts), so that a page can count from it.
   */
  constructor({ readResults, again = [1500, 5000], log, startedAt = new Date() }) {
    this.#read = readResults
    this.#again = again
    this.#log = log ?? (() => {})
    this.#startedAt = startedAt.toISOString()
  }

  /** The table now, or null before the core has said anything. */
  get state() { return this.#state }

  /** The games on record as last read, or null if they have not been. */
  get resultsRead() { return this.#results }

  /** Take the core's latest monitor snapshot. @param {unknown} snapshot */
  update(snapshot) {
    const state = publicState(snapshot, this.#startedAt)
    const stateText = JSON.stringify(state)
    if (stateText === this.#stateText) return
    const before = this.#state
    this.#state = state
    this.#stateText = stateText
    this.#emit('state', state)
    if (before && state && before.game_ended !== state.game_ended && this.#results) {
      for (const ms of this.#again) {
        const timer = setTimeout(() => {
          this.#timers.delete(timer)
          this.results(true).catch(() => {})
        }, ms)
        timer.unref?.()
        this.#timers.add(timer)
      }
    }
  }

  /**
   * The games on record, oldest first.
   * @param {boolean} [fresh] read them again even if they have been read
   * @returns {Promise<PublicResult[]>}
   */
  results(fresh = false) {
    if (this.#results && !fresh) return Promise.resolve(this.#results)
    this.#reading ??= this.#read().then(found => {
      const results = list(found).map(publicResult).filter(result => result !== null)
      const resultsText = JSON.stringify(results)
      if (resultsText !== this.#resultsText) {
        this.#results = results
        this.#resultsText = resultsText
        this.#emit('results', results)
      }
      return /** @type {PublicResult[]} */ (this.#results)
    }, error => {
      this.#log(`feed: the games on record could not be read: ${error instanceof Error ? error.message : error}`)
      throw error
    }).finally(() => { this.#reading = null })
    return this.#reading
  }

  /** Be told of every change. @param {Listener} listener @returns {() => void} to stop */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  close() {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    this.#listeners.clear()
  }

  /** @param {'state' | 'results'} kind @param {unknown} value */
  #emit(kind, value) {
    for (const listener of this.#listeners) {
      try { listener(kind, value) } catch (error) { this.#log(`feed: a listener failed: ${error instanceof Error ? error.message : error}`) }
    }
  }
}
