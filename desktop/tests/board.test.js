// @ts-check
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'
import { BOARD_LIMITS, Board, isBoardName } from '../src/board.js'
import { StreamServer, newToken } from '../src/stream.js'

const sleep = (/** @type {number} */ ms) => new Promise(done => setTimeout(done, ms))

/**
 * A request with a body, as a page of `origin` would send it.
 * @param {number} port @param {string} path @param {string | Buffer} body
 * @param {{ method?: string, type?: string, origin?: string | null, host?: string }} [how]
 * @returns {Promise<number>} the status
 */
function send(port, path, body, { method = 'PUT', type = 'application/json', origin = `http://127.0.0.1:${port}`, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((done, fail) => {
    /** @type {Record<string, string | number>} */
    const headers = { host, 'content-type': type, 'content-length': Buffer.byteLength(body) }
    if (origin !== null) headers.origin = origin
    const asked = request({ host: '127.0.0.1', port, path, method, headers }, reply => {
      reply.resume()
      reply.on('end', () => done(reply.statusCode ?? 0))
    })
    asked.on('error', fail)
    asked.end(body)
  })
}

/** @param {number} port @param {string} path @returns {Promise<{ status: number, body: string }>} */
function get(port, path) {
  return new Promise((done, fail) => {
    const asked = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, reply => {
      let body = ''
      reply.on('data', chunk => { body += chunk })
      reply.on('end', () => done({ status: reply.statusCode ?? 0, body }))
    })
    asked.on('error', fail)
    asked.end()
  })
}

test('the board keeps the last value under each name and tells its listeners', () => {
  const board = new Board()
  /** @type {[string, unknown][]} */
  const heard = []
  const stop = board.subscribe((name, value) => heard.push([name, value]))
  board.set('overlay', { title: 'A' })
  board.set('overlay', { title: 'B' })
  board.set('bgm', null)
  assert.deepEqual(board.all, { overlay: { title: 'B' }, bgm: null })
  assert.deepEqual(heard, [['overlay', { title: 'A' }], ['overlay', { title: 'B' }], ['bgm', null]])
  stop()
  board.set('bgm', 1)
  assert.equal(heard.length, 3)
  assert.throws(() => board.set('Bad Name', 1), /not a board name/)
  for (const name of ['a', 'bgm-command', '9lives']) assert.ok(isBoardName(name), name)
  for (const name of ['', '-a', 'A', 'a_b', 'a.b', 'x'.repeat(41)]) assert.ok(!isBoardName(name), name)
  const full = new Board()
  for (let i = 0; i < BOARD_LIMITS.names; i++) full.set(`n${i}`, i)
  assert.throws(() => full.set('one-more', 1), /full/)
  full.set('n0', 'again')
})

test('a page of this origin puts values on the board and every listener hears them', async () => {
  const token = newToken()
  const board = new Board()
  const server = new StreamServer({ token, board })
  const port = await server.listen(0)
  /** @type {{ kind: string, data: any }[]} */
  const events = []
  /** @type {import('node:http').IncomingMessage | null} */
  let listening = null
  try {
    await new Promise((done, fail) => {
      const asked = request({ host: '127.0.0.1', port, path: `/${token}/board`, headers: { host: `127.0.0.1:${port}` } }, reply => {
        listening = reply
        let buffer = ''
        reply.setEncoding('utf8')
        reply.on('data', chunk => {
          buffer += chunk
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const kind = /^event: (.*)$/m.exec(block)?.[1]
            const data = /^data: (.*)$/m.exec(block)?.[1]
            if (kind && data !== undefined) events.push({ kind, data: JSON.parse(data) })
          }
        })
        done(reply)
      })
      asked.on('error', fail)
      asked.end()
    })
    for (let i = 0; i < 100 && events.length < 1; i++) await sleep(10)
    assert.deepEqual(events[0], { kind: 'board', data: {} })

    assert.equal(await send(port, `/${token}/board/overlay`, JSON.stringify({ title: '标题' })), 204)
    assert.equal(await send(port, `/${token}/board/bgm`, 'null', { origin: null, type: 'application/json; charset=utf-8', host: `localhost:${port}` }), 204)
    for (let i = 0; i < 100 && events.length < 3; i++) await sleep(10)
    assert.deepEqual(events.slice(1), [
      { kind: 'set', data: { name: 'overlay', value: { title: '标题' } } },
      { kind: 'set', data: { name: 'bgm', value: null } },
    ])
    const once = await get(port, `/${token}/board.json`)
    assert.deepEqual(JSON.parse(once.body), { overlay: { title: '标题' }, bgm: null })

    // Refused: another origin, the wrong secret, a bad name, not JSON, too much, a write anywhere else.
    assert.equal(await send(port, `/${token}/board/overlay`, '{}', { origin: 'http://evil.example' }), 403)
    assert.equal(await send(port, `/${token}/board/overlay`, '{}', { origin: `http://localhost:${port}` }), 403)
    assert.equal(await send(port, `/${newToken()}/board/overlay`, '{}'), 404)
    assert.equal(await send(port, `/${token}/board/Over_lay`, '{}'), 404)
    assert.equal(await send(port, `/${token}/board/overlay`, '{}', { type: 'text/plain' }), 415)
    assert.equal(await send(port, `/${token}/board/overlay`, '{not json'), 400)
    assert.equal(await send(port, `/${token}/board/overlay`, JSON.stringify('x'.repeat(BOARD_LIMITS.bytes))), 413)
    assert.equal(await send(port, `/${token}/feed`, '{}'), 405)
    assert.equal(await send(port, `/${token}/board`, '{}'), 405)
    assert.equal(await send(port, `/${token}/board/overlay`, '{}', { method: 'POST' }), 405)
    assert.deepEqual(board.all, { overlay: { title: '标题' }, bgm: null })
  } finally {
    /** @type {import('node:http').IncomingMessage | null} */ (listening)?.destroy()
    await server.close()
  }
  const bare = new StreamServer({ token })
  const barePort = await bare.listen(0)
  try {
    assert.equal((await get(barePort, `/${token}/board`)).status, 404)
    assert.equal(await send(barePort, `/${token}/board/overlay`, '{}'), 405)
  } finally {
    await bare.close()
  }
})
