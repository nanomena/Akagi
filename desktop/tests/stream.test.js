// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Feed } from '../src/feed.js'
import { StreamServer, newToken, streamUrl } from '../src/stream.js'

const sleep = (/** @type {number} */ ms) => new Promise(done => setTimeout(done, ms))

/**
 * A request as a browser would make it, with the Host header it would send.
 * @param {number} port @param {string} path
 * @param {{ method?: string, host?: string }} [how]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function get(port, path, { method = 'GET', host = `127.0.0.1:${port}` } = {}) {
  return new Promise((done, fail) => {
    const asked = request({ host: '127.0.0.1', port, path, method, headers: { host } }, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => done({ status: response.statusCode ?? 0, headers: response.headers, body }))
    })
    asked.on('error', fail)
    asked.end()
  })
}

/**
 * Watch the stream: every complete part, as the JPEG bytes it carried.
 * @param {number} port @param {string} token
 */
function watch(port, token) {
  /** @type {Buffer[]} */
  const frames = []
  let buffer = Buffer.alloc(0)
  /** @type {import('node:http').IncomingMessage | null} */
  let response = null
  const opened = new Promise((done, fail) => {
    const asked = request({ host: '127.0.0.1', port, path: `/${token}/stream.mjpg`, headers: { host: `localhost:${port}` } }, reply => {
      response = reply
      reply.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const end = buffer.indexOf('\r\n\r\n')
          if (end < 0) break
          const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())?.[1])
          if (buffer.length < end + 4 + length + 2) break
          frames.push(buffer.subarray(end + 4, end + 4 + length))
          buffer = buffer.subarray(end + 4 + length + 2)
        }
      })
      done(reply)
    })
    asked.on('error', fail)
    asked.end()
  })
  return { frames, opened, close: () => response?.destroy() }
}

test('an address carries a new secret each time, and names this machine only', () => {
  const token = newToken()
  assert.match(token, /^[0-9a-f]{24}$/)
  assert.notEqual(newToken(), token)
  assert.equal(streamUrl(50123, token), `http://127.0.0.1:50123/${token}/`)
})

test('without the secret, from another name, or asked to change anything, the server gives nothing', async () => {
  const token = newToken()
  const server = new StreamServer({ token })
  const port = await server.listen(0)
  try {
    assert.equal((await get(port, '/')).status, 404)
    assert.equal((await get(port, `/${newToken()}/`)).status, 404)
    assert.equal((await get(port, `/${newToken()}/stream.mjpg`)).status, 404)
    assert.equal((await get(port, `/${token}/`, { host: `evil.example:${port}` })).status, 403)
    assert.equal((await get(port, `/${token}/`, { method: 'POST' })).status, 405)
    assert.equal((await get(port, `/${token}/../package.json`)).status, 404)
    assert.equal((await get(port, `/${token}/stream.js`)).status, 404)
  } finally {
    await server.close()
  }
})

test('the page and its script are served under the secret, with a policy that lets in nothing else', async () => {
  const token = newToken()
  const server = new StreamServer({ token })
  const port = await server.listen(0)
  try {
    const bare = await get(port, `/${token}`)
    assert.equal(bare.status, 308)
    assert.equal(bare.headers.location, `/${token}/`)
    const page = await get(port, `/${token}/`)
    assert.equal(page.status, 200)
    assert.match(String(page.headers['content-type']), /^text\/html/)
    assert.match(page.body, /<script src="viewer\.js"><\/script>/)
    const policy = String(page.headers['content-security-policy'])
    assert.match(policy, /default-src 'none'/)
    assert.match(policy, /script-src 'self'(;|$)/)
    assert.match(policy, /connect-src 'self'(;|$)/)
    const script = await get(port, `/${token}/viewer.js?v=1`, { host: `localhost:${port}` })
    assert.equal(script.status, 200)
    assert.match(String(script.headers['content-type']), /^text\/javascript/)
    assert.match(script.body, /stream\.mjpg/)
  } finally {
    await server.close()
  }
})

test('watchers get every frame as a part of its own, the last one at once, and are counted', async () => {
  const token = newToken()
  /** @type {number[]} */
  const counts = []
  const server = new StreamServer({ token, onWatchers: count => counts.push(count) })
  const port = await server.listen(0)
  try {
    const first = watch(port, token)
    const reply = /** @type {import('node:http').IncomingMessage} */ (await first.opened)
    assert.equal(reply.statusCode, 200)
    assert.equal(reply.headers['content-type'], 'multipart/x-mixed-replace; boundary=frame')
    for (let i = 0; i < 50 && server.watchers === 0; i++) await sleep(10)
    assert.equal(server.watchers, 1)
    server.push(Buffer.from('jpeg one'))
    server.push(Buffer.from('jpeg two, longer'))
    for (let i = 0; i < 50 && first.frames.length < 2; i++) await sleep(10)
    assert.deepEqual(first.frames.map(String), ['jpeg one', 'jpeg two, longer'])

    // One who comes later sees the latest frame without waiting for the next.
    const second = watch(port, token)
    await second.opened
    for (let i = 0; i < 50 && second.frames.length < 1; i++) await sleep(10)
    assert.deepEqual(second.frames.map(String), ['jpeg two, longer'])
    assert.equal(first.frames.length, 2, 'the first watcher is not sent the frame again')

    const watching = () => server.watchers
    first.close()
    for (let i = 0; i < 50 && watching() !== 1; i++) await sleep(10)
    assert.equal(watching(), 1)
    second.close()
    for (let i = 0; i < 50 && watching() !== 0; i++) await sleep(10)
    assert.deepEqual(counts, [1, 2, 1, 0])
  } finally {
    await server.close()
  }
})

test('a frame is sent again while nothing new comes, so that readers waiting for data stay', async () => {
  const token = newToken()
  const server = new StreamServer({ token })
  const port = await server.listen(0)
  try {
    const viewer = watch(port, token)
    await viewer.opened
    server.push(Buffer.from('still'))
    await sleep(2300)
    assert.ok(viewer.frames.length >= 2, `${viewer.frames.length} frames`)
    assert.ok(viewer.frames.every(frame => String(frame) === 'still'))
    viewer.close()
  } finally {
    await server.close()
  }
})

test('the port kept is used again, and another is found when it has been taken', async () => {
  const token = newToken()
  const first = new StreamServer({ token })
  const port = await first.listen(0)
  await first.close()
  const again = new StreamServer({ token })
  assert.equal(await again.listen(port), port)
  const other = new StreamServer({ token })
  const moved = await other.listen(port)
  assert.notEqual(moved, port)
  assert.ok(moved > 0)
  await again.close()
  await other.close()
  // Closing lets the watchers go and frees the port.
  const probe = createServer()
  await new Promise((done, fail) => { probe.once('error', fail); probe.listen(port, '127.0.0.1', () => done(undefined)) })
  await new Promise(done => probe.close(() => done(undefined)))
})

/**
 * Listen to the feed: every event, by name, with its data parsed.
 * @param {number} port @param {string} token
 */
function listen(port, token) {
  /** @type {{ kind: string, data: any }[]} */
  const events = []
  let buffer = ''
  /** @type {import('node:http').IncomingMessage | null} */
  let response = null
  const opened = new Promise((done, fail) => {
    const asked = request({ host: '127.0.0.1', port, path: `/${token}/feed`, headers: { host: `127.0.0.1:${port}` } }, reply => {
      response = reply
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
  return { events, opened, close: () => response?.destroy() }
}

/** @param {() => boolean} ready */
async function until(ready) {
  for (let i = 0; i < 100 && !ready(); i++) await sleep(10)
}

test('the feed tells a listener the table at once and on every change, and the games on record once read', async () => {
  const token = newToken()
  const feed = new Feed({ readResults: async () => [{ id: 'g1', our_rank: 2, log_path: 'games/g1.mjai.jsonl' }] })
  feed.update({ names: ['A', 'B', 'C', 'D'], game: null, round_ended: false, game_ended: false, hands: [], decision: { secret: true } })
  const server = new StreamServer({ token, feed })
  const port = await server.listen(0)
  try {
    const listener = listen(port, token)
    const reply = /** @type {import('node:http').IncomingMessage} */ (await listener.opened)
    assert.equal(reply.statusCode, 200)
    assert.match(String(reply.headers['content-type']), /^text\/event-stream/)
    await until(() => listener.events.length >= 2)
    assert.deepEqual(listener.events.map(event => event.kind), ['state', 'results'])
    assert.deepEqual(listener.events[0].data.names, ['A', 'B', 'C', 'D'])
    assert.deepEqual(listener.events[1].data, [{ id: 'g1', our_rank: 2, match_info: null }])

    feed.update({ names: ['A', 'B', 'C', 'D'], game: null, round_ended: false, game_ended: true, hands: [] })
    await until(() => listener.events.length >= 3)
    assert.equal(listener.events[2].kind, 'state')
    assert.equal(listener.events[2].data.game_ended, true)

    const once = await get(port, `/${token}/feed.json`)
    assert.equal(once.status, 200)
    assert.match(String(once.headers['content-type']), /^application\/json/)
    const body = JSON.parse(once.body)
    assert.equal(body.state.game_ended, true)
    assert.deepEqual(body.results, [{ id: 'g1', our_rank: 2, match_info: null }])
    assert.ok(!once.body.includes('secret') && !once.body.includes('log_path'))
    listener.close()
  } finally {
    await server.close()
    feed.close()
  }
  // A server given no feed and no folder has neither.
  const bare = new StreamServer({ token })
  const barePort = await bare.listen(0)
  try {
    assert.equal((await get(barePort, `/${token}/feed`)).status, 404)
    assert.equal((await get(barePort, `/${token}/feed.json`)).status, 404)
    assert.equal((await get(barePort, `/${token}/pages/`)).status, 404)
  } finally {
    await bare.close()
  }
})

test('the folder of pages is served under the secret, and nothing outside it or hidden in it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akagi-pages-'))
  const pages = path.join(root, 'stream-pages')
  fs.mkdirSync(path.join(pages, 'overlay'), { recursive: true })
  fs.mkdirSync(path.join(pages, 'music'))
  fs.writeFileSync(path.join(pages, 'index.html'), '<p>home</p>')
  fs.writeFileSync(path.join(pages, 'overlay', 'index.html'), '<script src="overlay.js"></script>')
  fs.writeFileSync(path.join(pages, 'overlay', 'overlay.js'), 'console.log(1)')
  fs.writeFileSync(path.join(pages, 'music', 'Song one.mp3'), Buffer.from('0123456789'))
  fs.writeFileSync(path.join(pages, '.secret'), 'no')
  fs.writeFileSync(path.join(root, 'outside.txt'), 'no')
  const token = newToken()
  const server = new StreamServer({ token, pages })
  const port = await server.listen(0)
  try {
    assert.equal((await get(port, `/${newToken()}/pages/`)).status, 404)
    const top = await get(port, `/${token}/pages`)
    assert.equal(top.status, 308)
    assert.equal(top.headers.location, `/${token}/pages/`)
    const home = await get(port, `/${token}/pages/`)
    assert.equal(home.status, 200)
    assert.equal(home.body, '<p>home</p>')
    const policy = String(home.headers['content-security-policy'])
    assert.match(policy, /default-src 'none'/)
    assert.match(policy, /connect-src 'self' ws:\/\/127\.0\.0\.1:\* ws:\/\/localhost:\*/)

    const folder = await get(port, `/${token}/pages/overlay`)
    assert.equal(folder.status, 308)
    assert.equal(folder.headers.location, `/${token}/pages/overlay/`)
    assert.match((await get(port, `/${token}/pages/overlay/`)).body, /overlay\.js/)
    const script = await get(port, `/${token}/pages/overlay/overlay.js`)
    assert.match(String(script.headers['content-type']), /^text\/javascript/)
    assert.equal(script.headers['content-security-policy'], undefined)

    const song = await get(port, `/${token}/pages/music/Song%20one.mp3`)
    assert.equal(song.status, 200)
    assert.equal(song.headers['content-type'], 'audio/mpeg')
    assert.equal(song.headers['accept-ranges'], 'bytes')
    assert.equal(song.body, '0123456789')

    for (const away of ['.secret', '..%2Foutside.txt', '%2e%2e/outside.txt', 'overlay/../../outside.txt', 'missing.html', 'overlay/overlay.js/']) {
      assert.equal((await get(port, `/${token}/pages/${away}`)).status, 404, away)
    }
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('media in the folder answers a range request with just that range', async () => {
  const pages = fs.mkdtempSync(path.join(os.tmpdir(), 'akagi-pages-'))
  fs.writeFileSync(path.join(pages, 'song.ogg'), Buffer.from('0123456789'))
  const token = newToken()
  const server = new StreamServer({ token, pages })
  const port = await server.listen(0)
  /** @param {string} range @returns {Promise<{ status?: number, range?: string, length?: string, body: string }>} */
  const part = range => new Promise((done, fail) => {
    const asked = request({ host: '127.0.0.1', port, path: `/${token}/pages/song.ogg`, headers: { host: `127.0.0.1:${port}`, range } }, reply => {
      let body = ''
      reply.on('data', chunk => { body += chunk })
      reply.on('end', () => done({ status: reply.statusCode, range: reply.headers['content-range'], length: reply.headers['content-length'], body }))
    })
    asked.on('error', fail)
    asked.end()
  })
  try {
    assert.deepEqual(await part('bytes=2-5'), { status: 206, range: 'bytes 2-5/10', length: '4', body: '2345' })
    assert.deepEqual(await part('bytes=-3'), { status: 206, range: 'bytes 7-9/10', length: '3', body: '789' })
    assert.deepEqual(await part('bytes=20-'), { status: 416, range: 'bytes */10', length: undefined, body: '' })
    const head = await get(port, `/${token}/pages/song.ogg`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-length'], '10')
    assert.equal(head.body, '')
  } finally {
    await server.close()
    fs.rmSync(pages, { recursive: true, force: true })
  }
})
