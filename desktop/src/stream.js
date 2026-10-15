// @ts-check
// The game, offered to a streaming program on this computer. A small HTTP
// server on 127.0.0.1 hands out the frames it is given as a Motion JPEG stream,
// and a page that shows that stream filling its window — for a program's
// browser source. Plain Node, so it is tested without Electron; the frames
// come from `frames.js`.
//
//   /<token>/             the page
//   /<token>/viewer.js    the page's script
//   /<token>/stream.mjpg  the frames, one JPEG after another
//
// The token is a secret: without it every address is a 404, so nothing else
// on the machine can find the stream by trying ports.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Frames a second at most. A frame is the game view's own size; the page scales it to its window. */
export const STREAM_FPS = 30

const BOUNDARY = 'frame'
/** A watcher further behind than this many bytes misses frames until it catches up. */
const BEHIND = 4 * 1024 * 1024
/** With no new frame for this long, the last one is sent again, so that readers that wait for data do not give up. */
const QUIET_MS = 1000
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
  #token
  #onWatchers
  /** @type {Record<string, { type: string, body: Buffer }>} */
  #files

  /**
   * @param {{ token: string, onWatchers?: (count: number) => void }} options
   */
  constructor({ token, onWatchers }) {
    this.#token = token
    this.#onWatchers = onWatchers ?? (() => {})
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
    const server = this.#server
    this.#server = null
    this.#last = null
    for (const response of this.#watchers) response.destroy()
    this.#watchers.clear()
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
    if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(405)
    const [, token, ...rest] = (request.url ?? '').split('?')[0].split('/')
    const name = rest.join('/')
    if (!token || !same(token, this.#token)) return refuse(404)
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
}
