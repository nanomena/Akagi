// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FEED_VERSION, Feed, publicResult, publicState } from '../src/feed.js'

const sleep = (/** @type {number} */ ms) => new Promise(done => setTimeout(done, ms))

/** A monitor snapshot as the core sends it, with everything the feed must not pass on. */
function snapshot(overrides = {}) {
  return {
    revision: 7,
    context: { game: 1, round: 2, event_seq: 40 },
    names: ['Ann', 'Bo', 'Cy', 'Di'],
    red_fives: true,
    game: {
      bakaze: 'E', kyoku: 2, honba: 1, kyotaku: 1, oya: 1, current_player: 2, turn_count: 9, phase: 'WaitAct', is_done: false,
      num_players: 4, our_seat: 0, dora_markers: ['3p'],
      players: [0, 1, 2, 3].map(seat => ({
        seat, tehai: ['1m', '2m', '3m'], melds: [], river: [{ tile: '9s' }], score: 25000 - seat * 1000,
        riichi_declared: seat === 2, riichi_stage: false, double_riichi: false, riichi_declaration_index: null, kita_tiles: [], drawn_tile: '5z',
      })),
    },
    view: { hand: ['1m', '2m', '3m'] },
    round_ended: false,
    game_ended: false,
    capture: 'running',
    bot: 'ready',
    service: 'connected',
    service_error: null,
    server: 'up',
    sync_error: null,
    brand: 'Model A',
    facts: [{ name: 'depth', value: 'secret fact' }],
    autoplay_enabled: true,
    decision: { id: 3, response: { type: 'dahai', pai: '9s', meta: { candidates: 'secret candidates' } } },
    previous_decision: { id: 2 },
    result: null,
    previous_result: null,
    hands: [
      { round: 1, bakaze: 'E', kyoku: 1, honba: 0, events: 50, result: { kind: 'hora', scores: [33000, 17000, 25000, 25000], deltas: [8000, -8000, 0, 0], hands: [{ seat: 0, tiles: ['1m', '1m'], winning_tile: '1m', target: 1, ura_markers: ['4s'] }] } },
      { round: 2, bakaze: 'E', kyoku: 2, honba: 1, events: 12, result: null },
    ],
    events: [{ seq: 1, ts_ms: 1, event: { type: 'tsumo' } }],
    last_event_ms: 123,
    ...overrides,
  }
}

test('the table is passed on, and nothing about the bot', () => {
  const state = publicState(snapshot())
  assert.deepEqual(state, {
    version: FEED_VERSION,
    names: ['Ann', 'Bo', 'Cy', 'Di'],
    our_seat: 0,
    game: { bakaze: 'E', kyoku: 2, honba: 1, kyotaku: 1, oya: 1, num_players: 4, scores: [25000, 24000, 23000, 22000], riichi: [false, false, true, false], dora_markers: ['3p'] },
    round_ended: false,
    game_ended: false,
    hands: [
      { round: 1, bakaze: 'E', kyoku: 1, honba: 0, result: { kind: 'hora', scores: [33000, 17000, 25000, 25000], deltas: [8000, -8000, 0, 0], hands: [{ seat: 0, tiles: ['1m', '1m'], winning_tile: '1m', target: 1, ura_markers: ['4s'] }] } },
      { round: 2, bakaze: 'E', kyoku: 2, honba: 1, result: null },
    ],
  })
  const sent = JSON.stringify(state)
  for (const left of ['secret', 'Model A', 'autoplay', 'tehai', 'drawn', 'decision', 'facts', 'service', '5z']) {
    assert.ok(!sent.includes(left), `"${left}" must not be in the feed`)
  }
  assert.equal(publicState(null), null)
  assert.equal(publicState(snapshot({ game: null }))?.game, null)
})

test('a game on record is passed on without where its log is or the ids of its replay', () => {
  const record = {
    id: '01J0000000000000000000000', started_at: '2026-10-14T10:00:00Z', ended_at: '2026-10-14T10:30:00Z',
    platform: 'majsoul', num_players: 4, kyoku_mode: 'east_south', names: ['Ann', 'Bo', 'Cy', 'Di'], our_seat: 0,
    final_scores: [40000, 30000, 20000, 10000], final_ranks: [1, 2, 3, 4], our_rank: 1, our_delta: 15000,
    stats: { round: 8, agari: 3 }, our_rank_points: 85, yaku: { 1: 2 },
    match_info: { platform: 'majsoul', game_uuid: 'replay-id', mode_id: 12, room_id: 0 },
    log_path: 'games/01J0000000000000000000000.mjai.jsonl',
  }
  const result = publicResult(record)
  assert.deepEqual(result?.match_info, { platform: 'majsoul', mode_id: 12, room_id: 0 })
  assert.equal(result?.our_rank_points, 85)
  assert.deepEqual(result?.final_ranks, [1, 2, 3, 4])
  const sent = JSON.stringify(result)
  assert.ok(!sent.includes('replay-id'))
  assert.ok(!sent.includes('log_path'))
  assert.deepEqual(publicResult({ ...record, match_info: { platform: 'tenhou', log_id: 'log', go_type: 169, lobby: 0 } })?.match_info, { platform: 'tenhou', go_type: 169, lobby: 0 })
  assert.deepEqual(publicResult({ ...record, match_info: { platform: 'later', anything: 1 } })?.match_info, { platform: 'later' })
})

test('listeners hear of the table only when it changes', () => {
  const feed = new Feed({ readResults: async () => [] })
  /** @type {[string, unknown][]} */
  const heard = []
  const stop = feed.subscribe((kind, value) => heard.push([kind, value]))
  feed.update(snapshot())
  feed.update(snapshot({ revision: 8, decision: { id: 4 }, events: [] }))
  assert.equal(heard.length, 1, 'a new decision or event alone changes nothing that is passed on')
  feed.update(snapshot({ round_ended: true }))
  assert.equal(heard.length, 2)
  assert.equal(/** @type {any} */ (heard[1][1]).round_ended, true)
  stop()
  feed.update(snapshot())
  assert.equal(heard.length, 2)
  feed.close()
})

test('the games on record are read once asked for, and again after a game ends', async () => {
  let reads = 0
  let records = [{ id: 'a', log_path: 'games/a' }]
  const feed = new Feed({ readResults: async () => { reads++; return records }, again: [20, 60] })
  feed.update(snapshot())
  feed.update(snapshot({ game_ended: true }))
  await sleep(100)
  assert.equal(reads, 0, 'nobody asked, so nothing is read')
  assert.equal(feed.resultsRead, null)

  /** @type {unknown[]} */
  const heard = []
  feed.subscribe((kind, value) => { if (kind === 'results') heard.push(value) })
  assert.deepEqual(await feed.results(), [{ id: 'a', match_info: null }])
  assert.equal(reads, 1)
  await feed.results()
  assert.equal(reads, 1, 'read once')

  // A new game begins, and the last one is written a moment later.
  feed.update(snapshot({ game_ended: false }))
  records = [...records, { id: 'b', log_path: 'games/b' }]
  await sleep(150)
  assert.equal(reads, 3)
  assert.deepEqual(heard, [[{ id: 'a', match_info: null }], [{ id: 'a', match_info: null }, { id: 'b', match_info: null }]], 'told when they changed, not when they were read the same')
  feed.close()
})

test('records that cannot be read are said so, and read again when asked', async () => {
  /** @type {string[]} */
  const said = []
  let fail = true
  const feed = new Feed({ readResults: async () => { if (fail) throw new Error('core gone'); return [] }, log: message => said.push(message) })
  await assert.rejects(feed.results(), /core gone/)
  assert.match(said[0], /core gone/)
  fail = false
  assert.deepEqual(await feed.results(), [])
  feed.close()
})
