// @ts-check
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { test } from 'node:test'
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
