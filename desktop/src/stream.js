// @ts-check
// The game, offered to a streaming program on this computer. A small HTTP
// server on 127.0.0.1 hands out the frames it is given as a Motion JPEG stream,
// and a page that shows that stream filling its window — for a program's
// browser source. Beside them, for pages of the user's own that the program
// shows around the game, what the table is doing and the folder those pages
// are kept in. Plain Node, so it is tested without Electron; the frames come
// from `frames.js`, the table from `feed.js`.
//
//   /<token>/             the page
//   /<token>/viewer.js    the page's script
//   /<token>/stream.mjpg  the frames, one JPEG after another
//   /<token>/feed         the table and the games on record, as server-sent events
//   /<token>/feed.json    the same, once
//   /<token>/board        what the pages share (`board.js`), as server-sent events; PUT /<token>/board/<name> puts a value
//   /<token>/board.json   the board, once
//   /<token>/pages/…      the folder of pages (`pages.js`)
//
// The token is a secret: without it every address is a 404, so nothing else
// on the machine can find the stream by trying ports.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_LIMITS, isBoardName } from './board.js'
import { servePage } from './pages.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Frames a second at most. A frame is the game view's own size; the page scales it to its window. */
export const STREAM_FPS = 30

const BOUNDARY = 'frame'
/** A watcher further behind than this many bytes misses frames until it catches up. */
const BEHIND = 4 * 1024 * 1024
/** With no new frame for this long, the last one is sent again, so that readers that wait for data do not give up. */
const QUIET_MS = 1000
/** How often a feed's listeners are sent a comment, so that a connection that has gone is noticed. */
const FEED_KEEPALIVE_MS = 15000
const POLICY = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; form-action 'none'"

/** @returns {string} a new secret for the address */
export const newToken = () => randomBytes(12).toString('hex')

/** @param {number} port @param {string} token */
export const streamUrl = (port, token) => `http://127.0.0.1:${port}/${token}/`

/** @param {string} a @param {string} b */
function same(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * The server. It listens while the option is on; it tells its owner how many
 * are watching, so that frames are made only while someone is.
 */
export class StreamServer {
  /** @type {import('node:http').Server | null} */
  #server = null
  /** @type {Set<import('node:http').ServerResponse>} */
  #watchers = new Set()
  /** @type {Buffer | null} */
  #last = null
  #lastAt = 0
  /** @type {NodeJS.Timeout | undefined} */
  #quiet
  /** @type {NodeJS.Timeout | undefined} */
  #keepalive
  /** @type {Set<import('node:http').ServerResponse>} */
  #listeners = new Set()
  #token
  #onWatchers
  #feed
  #board
  #pages
  /** @type {Record<string, { type: string, body: Buffer }>} */
  #files

  /**
   * @param {{ token: string, onWatchers?: (count: number) => void, feed?: import('./feed.js').Feed,
   *   board?: import('./board.js').Board, pages?: string }} options
   *   `feed`: what the table is doing, for `/feed`; `board`: what the pages share, for `/board`;
   *   `pages`: the folder served at `/pages/`
   */
  constructor({ token, onWatchers, feed, board, pages }) {
    this.#token = token
    this.#onWatchers = onWatchers ?? (() => {})
    this.#feed = feed ?? null
    this.#board = board ?? null
    this.#pages = pages ?? null
    this.#files = {
      '': { type: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(HERE, 'viewer.html')) },
      'viewer.js': { type: 'text/javascript; charset=utf-8', body: fs.readFileSync(path.join(HERE, 'viewer.js')) },
    }
  }

  get port() {
    const address = this.#server?.address()
    return address && typeof address === 'object' ? address.port : 0
  }

  get watchers() { return this.#watchers.size }

  /**
   * Listen on `port`, or on any free port if that one is taken or `port` is 0.
   * @param {number} port
   * @returns {Promise<number>} the port listened on
   */
  async listen(port) {
    if (this.#server) return this.port
    const server = createServer((request, response) => this.#answer(request, response))
    const on = (/** @type {number} */ at) => new Promise((done, fail) => {
      server.once('error', fail)
      server.listen(at, '127.0.0.1', () => { server.off('error', fail); done(undefined) })
    })
    try {
      await on(port)
    } catch (error) {
      if (!port || /** @type {NodeJS.ErrnoException} */ (error).code !== 'EADDRINUSE') throw error
      await on(0)
    }
    this.#server = server
    this.#quiet = setInterval(() => {
      if (this.#last && Date.now() - this.#lastAt >= QUIET_MS) this.#send(this.#last)
    }, QUIET_MS)
    this.#keepalive = setInterval(() => {
      for (const response of this.#listeners) response.write(': still here\n\n')
    }, FEED_KEEPALIVE_MS)
    return this.port
  }

  /** Send a frame to everyone watching. @param {Buffer} jpeg */
  push(jpeg) {
    this.#last = jpeg
    this.#send(jpeg)
  }

  /** Stop listening and let every watcher go. */
  async close() {
    clearInterval(this.#quiet)
    clearInterval(this.#keepalive)
    const server = this.#server
    this.#server = null
    this.#last = null
    for (const response of this.#watchers) response.destroy()
    this.#watchers.clear()
    for (const response of this.#listeners) response.destroy()
    this.#listeners.clear()
    if (server) await new Promise(done => server.close(() => done(undefined)))
  }

  /** @param {Buffer} jpeg @param {Iterable<import('node:http').ServerResponse>} to */
  #send(jpeg, to = this.#watchers) {
    this.#lastAt = Date.now()
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`)
    for (const response of to) {
      if (response.writableLength > BEHIND) continue
      response.write(head)
      response.write(jpeg)
      response.write('\r\n')
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  #answer(request, response) {
    const refuse = (/** @type {number} */ status) => { response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end() }
    // Only this machine, by its own name for itself: a page elsewhere that
    // has a name of its own point here gets nothing.
    const host = request.headers.host ?? ''
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return refuse(403)
    const writing = request.method === 'PUT'
    if (!writing && request.method !== 'GET' && request.method !== 'HEAD') return refuse(405)
    const [, token, ...rest] = (request.url ?? '').split('?')[0].split('/')
    const name = rest.join('/')
    if (!token || !same(token, this.#token)) return refuse(404)
    if (writing) {
      // A value on the board is the one thing a page may change here.
      if (rest.length !== 2 || rest[0] !== 'board' || !this.#board) return refuse(405)
      return void this.#put(this.#board, rest[1], host, request, response).catch(() => response.destroy())
    }
    // The page's own files are named relative to it, so it has to be read as a folder.
    if (rest.length === 0) { response.writeHead(308, { Location: `/${token}/`, 'Cache-Control': 'no-store' }).end(); return }

    if (name === 'stream.mjpg') {
      response.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      if (request.method === 'HEAD') return response.end()
      // Answered at once, frames or not: a reader is not left to wonder whether the address is right.
      response.flushHeaders()
      response.socket?.setNoDelay(true)
      this.#watchers.add(response)
      const gone = () => {
        if (this.#watchers.delete(response)) this.#onWatchers(this.#watchers.size)
      }
      response.once('close', gone)
      this.#onWatchers(this.#watchers.size)
      if (this.#last) this.#send(this.#last, [response])
      return
    }

    if (name === 'feed' || name === 'feed.json') {
      if (!this.#feed) return refuse(404)
      if (name === 'feed') return this.#listen(this.#feed, request, response)
      return void this.#tell(this.#feed, request, response)
    }
    if (name === 'board' || name === 'board.json') {
      if (!this.#board) return refuse(404)
      if (name === 'board') return this.#listenBoard(this.#board, request, response)
      return json(response, request, this.#board.all)
    }
    if (rest[0] === 'pages') {
      if (!this.#pages) return refuse(404)
      if (rest.length === 1) { response.writeHead(308, { Location: `/${token}/pages/`, 'Cache-Control': 'no-store' }).end(); return }
      return void servePage(this.#pages, rest.slice(1), `/${token}/pages/`, request, response).catch(() => response.destroy())
    }

    const file = Object.hasOwn(this.#files, name) ? this.#files[name] : null
    if (!file) return refuse(404)
    response.writeHead(200, {
      'Content-Type': file.type,
      'Content-Length': file.body.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    response.end(request.method === 'HEAD' ? undefined : file.body)
  }

  /**
   * Keep a listener told: the table at once and on every change, the games on
   * record once read and whenever they change.
   * @param {import('./feed.js').Feed} feed
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  #listen(feed, request, response) {
    const send = this.#events(request, response, feed.subscribe.bind(feed))
    if (!send) return
    send('state', feed.state)
    // Once read, the games on record are sent here; until then, reading them sends them to every listener.
    if (feed.resultsRead) send('results', feed.resultsRead)
    else feed.results().catch(() => {})
  }

  /**
   * Keep a page told of the board: all of it at once, then each value put.
   * @param {import('./board.js').Board} board
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  #listenBoard(board, request, response) {
    const send = this.#events(request, response, tell => board.subscribe((name, value) => tell('set', { name, value })))
    if (send) send('board', board.all)
  }

  /**
   * Open a stream of server-sent events, subscribed while it is open.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {(send: (kind: string, value: unknown) => void) => () => void} subscribe
   * @returns {((kind: string, value: unknown) => void) | null} null for a `HEAD`
   */
  #events(request, response, subscribe) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    if (request.method === 'HEAD') {
      response.end()
      return null
    }
    response.flushHeaders()
    response.socket?.setNoDelay(true)
    const send = (/** @type {string} */ kind, /** @type {unknown} */ value) => {
      response.write(`event: ${kind}\ndata: ${JSON.stringify(value)}\n\n`)
    }
    response.write('retry: 2000\n\n')
    const off = subscribe(send)
    this.#listeners.add(response)
    response.once('close', () => {
      off()
      this.#listeners.delete(response)
    })
    return send
  }

  /**
   * The table and the games on record, once.
   * @param {import('./feed.js').Feed} feed
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async #tell(feed, request, response) {
    let results = null
    try { results = await feed.results() } catch { /* sent as null: the table is worth having without them */ }
    json(response, request, { state: feed.state, results })
  }

  /**
   * Put a value on the board, from a page of this origin: JSON, `BOARD_LIMITS.bytes` at most.
   * @param {import('./board.js').Board} board
   * @param {string} name
   * @param {string} host the name this request reached the server by
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async #put(board, name, host, request, response) {
    const answer = (/** @type {number} */ status) => { response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end() }
    // A browser names the page a write comes from; a page of any other origin may not write.
    const origin = request.headers.origin
    if (origin !== undefined && origin !== `http://${host}`) return answer(403)
    if (!isBoardName(name)) return answer(404)
    if (!/^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '')) return answer(415)
    if (Number(request.headers['content-length'] ?? 0) > BOARD_LIMITS.bytes) return answer(413)
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > BOARD_LIMITS.bytes) {
        response.writeHead(413, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', Connection: 'close' }).end(() => request.destroy())
        return
      }
      chunks.push(chunk)
    }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return answer(400) }
    try { board.set(name, value) } catch { return answer(409) }
    answer(204)
  }
}

/**
 * Answer with `value` as JSON.
 * @param {import('node:http').ServerResponse} response
 * @param {import('node:http').IncomingMessage} request
 * @param {unknown} value
 */
function json(response, request, value) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}
