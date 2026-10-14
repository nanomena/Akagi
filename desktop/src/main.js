// @ts-check
// The window Akagi runs in. One Chromium on every platform shows the game and
// the monitor's dock under it, in one 4:3 window, and serves the DevTools
// endpoint the core captures the game through. Everything else — the bridge,
// the tracker, the bot, autoplay, the monitor snapshot — is the core's
// (`src/headless`), a child process this file starts and talks to in JSON lines.
//
//   --data=<dir>      where everything is kept (default: <appData>/akagi-desktop):
//                     config.toml, bots, logs and history, and the browser profile
//   --core=<file>     the core's executable (default: the packaged one)
//   --dock=<dir>      the built interface (default: the packaged one)
//   --cdp-port=<n>    the local DevTools port (default: any free port)
// Each can also be given as AKAGI_DATA, AKAGI_CORE, AKAGI_DOCK, AKAGI_CDP_PORT.

import { BaseWindow, BrowserWindow, Menu, WebContentsView, app, dialog, ipcMain, net, protocol, screen } from 'electron'
import fs from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Core } from './core.js'
import { MIN, RATIO, conform, framedRatio, gameBounds, openingSize, restoredBounds, settle, trailBounds } from './layout.js'
import { policyFor } from './policy.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** The interface's address. A scheme of its own, so the page has an origin and absolute paths. */
const DOCK = 'app://dock/'
/** The game's session: its own cookies and storage, kept between runs, apart from the interface's. */
const GAME_PARTITION = 'persist:game'
/** The page's own background: behind the interface while it loads, and beside the canvas if the window is ever off its ratio. */
const BACKGROUND = '#ece9e4'
/** What the game may ask for. It copies room numbers and pastes them; nothing else is its to have. */
const GAME_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write'])
/** @param {string} name */
const option = name => app.commandLine.getSwitchValue(name) || process.env[`AKAGI_${name.toUpperCase().replaceAll('-', '_')}`] || ''
const CORE_NAME = process.platform === 'win32' ? 'akagi-core.exe' : 'akagi-core'

const DATA = path.resolve(option('data') || path.join(app.getPath('appData'), 'akagi-desktop'))
const CORE = path.resolve(option('core') || (app.isPackaged ? path.join(process.resourcesPath, 'core', CORE_NAME) : path.join(HERE, '..', '..', 'target', 'release', CORE_NAME)))
const DOCK_FILES = path.resolve(option('dock') || (app.isPackaged ? path.join(process.resourcesPath, 'dock') : path.join(HERE, '..', '..', 'frontend', 'dist')))
const WINDOW_STATE = path.join(DATA, 'window.json')

/** @returns {Promise<number>} a local port nothing is listening on */
const freePort = () => new Promise((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address())
    probe.close(() => done(port))
  })
})

/** @type {BaseWindow | null} */
let window = null
/** @type {WebContentsView | null} */
let dock = null
/** @type {WebContentsView | null} */
let game = null
/** @type {Core | null} */
let core = null
/** Autoplay's pointer, drawn over the game while the option is on. */
/** @type {BrowserWindow | null} */
let trail = null
/** Where the game view is in the window's content, while it is shown. */
/** @type {import('./layout.js').Rect | null} */
let gameAt = null
/** The window's options as the core last saved them. */
/** @type {{ always_on_top: boolean, pointer_trail?: boolean, version?: string }} */
let options = { always_on_top: false }
let cdpPort = 0
let quitting = false

/** Stop with a message. Nothing is left half-done by it: the core goes when we do. */
function fail(/** @type {string} */ title, /** @type {string} */ detail) {
  if (quitting) return
  quitting = true
  dialog.showErrorBox(title, detail)
  app.exit(1)
}

/** The end of what the core wrote to stderr, as plain text. */
function lastWords() {
  // The core colours its console output; a dialog would show the codes.
  return (core?.stderr ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-12).join('\n')
}

/** Serve the built interface, and nothing outside its folder. */
function serveDock() {
  protocol.handle('app', async request => {
    const url = new URL(request.url)
    const file = path.join(DOCK_FILES, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    const inside = path.relative(DOCK_FILES, file)
    if (url.host !== 'dock' || inside.startsWith('..') || path.isAbsolute(inside)) return new Response(null, { status: 404 })
    try {
      if (file.endsWith('.html')) {
        const html = await fs.promises.readFile(file, 'utf8')
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policyFor(html) } })
      }
      return await net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

/** @returns {unknown} the JSON in `file`, or null */
function readJson(/** @type {string} */ file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** @param {BaseWindow} frame */
function contentSize(frame) {
  const [width, height] = frame.getContentSize()
  return { width, height }
}

/**
 * Keep the window's content on the canvas's ratio while an edge is dragged.
 * macOS and X11 hold a content ratio themselves. Windows holds the ratio of the
 * whole window, title bar included, so there the ratio asked for is the one
 * that puts the content right at its present width, said again as that changes.
 * Wherever a drag ends, the content is then put exactly on the ratio.
 * @param {BaseWindow} frame
 */
function holdRatio(frame) {
  if (process.platform === 'win32') {
    const [outerWidth, outerHeight] = frame.getSize()
    const inner = contentSize(frame)
    const border = { width: outerWidth - inner.width, height: outerHeight - inner.height }
    const say = () => frame.setAspectRatio(framedRatio(contentSize(frame).width, border))
    say()
    frame.on('resize', say)
  } else {
    frame.setAspectRatio(RATIO)
  }

  let before = contentSize(frame)
  const rest = () => {
    const now = contentSize(frame)
    const exact = settle(before, now)
    if (Math.abs(exact.width - now.width) > 1 || Math.abs(exact.height - now.height) > 1) frame.setContentSize(exact.width, exact.height)
    before = exact
  }
  if (process.platform === 'linux') {
    // No event says a drag has ended here, and Wayland holds no ratio at all:
    // the size is at rest once it has stopped changing.
    /** @type {NodeJS.Timeout | undefined} */
    let quiet
    frame.on('resize', () => { clearTimeout(quiet); quiet = setTimeout(rest, 250) })
  } else {
    frame.on('resized', rest)
  }
}

/** @param {import('./core.js').Ready} ready */
function openWindow(ready) {
  options = { ...ready.monitor, version: ready.version }
  const saved = restoredBounds(readJson(WINDOW_STATE), screen.getAllDisplays().map(display => display.workArea))
  const size = saved ?? openingSize(screen.getPrimaryDisplay().workAreaSize)
  const frame = window = new BaseWindow({
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    width: size.width,
    height: size.height,
    useContentSize: true,
    minWidth: MIN.width,
    minHeight: MIN.height,
    title: `${ready.brand} · 雀魂`,
    // A maximized or full-screen window cannot keep the canvas's ratio.
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: ready.monitor.always_on_top,
    backgroundColor: BACKGROUND,
    show: false,
  })
  holdRatio(frame)

  const view = dock = new WebContentsView({ webPreferences: { preload: path.join(HERE, 'preload.cjs'), sandbox: true, contextIsolation: true } })
  view.setBackgroundColor(BACKGROUND)
  frame.contentView.addChildView(view)
  const fill = () => view.setBounds({ x: 0, y: 0, ...contentSize(frame) })
  fill()
  frame.on('resize', fill)
  // The trail is a window of its own over the game view, and has to follow it.
  frame.on('move', placeTrail)
  frame.on('resize', placeTrail)

  // The interface is one page of our own files: it goes nowhere and opens nothing.
  const page = view.webContents
  page.setWindowOpenHandler(() => ({ action: 'deny' }))
  page.on('will-navigate', (event, url) => { if (!url.startsWith(DOCK)) event.preventDefault() })
  page.on('render-process-gone', () => page.reload())
  page.once('did-finish-load', () => frame.show())
  page.on('did-fail-load', (_event, _code, description, _url, isMainFrame) => {
    if (isMainFrame) fail('The interface could not be loaded.', `${description}\n${DOCK_FILES}`)
  })
  void page.loadURL(`${DOCK}index.html?view=monitor`)

  frame.on('close', () => {
    const [x, y] = frame.getPosition()
    try { fs.writeFileSync(WINDOW_STATE, JSON.stringify({ x, y, ...contentSize(frame) })) } catch { /* where the window was is a convenience */ }
  })
  frame.on('closed', () => {
    // Views outlive the window they were in unless they are closed.
    game?.webContents.close()
    view.webContents.close()
    trail?.destroy()
    window = dock = game = trail = null
    app.quit()
  })
}

/** The game view: its own session, no way into the shell, and never put to sleep. */
function createGame() {
  // `backgroundThrottling: false` keeps the page live — drawing, and taking the
  // input autoplay sends it — while the window is covered or minimized.
  const view = new WebContentsView({ webPreferences: { partition: GAME_PARTITION, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  view.setBackgroundColor('#000000')
  const page = view.webContents
  const web = (/** @type {string} */ url) => /^https?:\/\//i.test(url)
  page.on('will-navigate', (event, url) => { if (!web(url)) event.preventDefault() })
  // Signing in through another service opens a window, and that window has to
  // share the game's session to hand the sign-in back.
  page.setWindowOpenHandler(({ url }) => web(url)
    ? { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 720, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true } } }
    : { action: 'deny' })
  page.on('render-process-gone', () => page.reload())
  page.session.setPermissionRequestHandler((_contents, permission, allow) => allow(GAME_PERMISSIONS.has(permission)))
  page.session.setPermissionCheckHandler((_contents, permission) => GAME_PERMISSIONS.has(permission))
  return view
}

/** @param {WebContentsView} view @returns {Promise<string>} the view's DevTools target id */
async function targetOf(view) {
  const tools = view.webContents.debugger
  tools.attach('1.3')
  try {
    const { targetInfo } = await tools.sendCommand('Target.getTargetInfo')
    return targetInfo.targetId
  } finally {
    tools.detach()
  }
}

/** Put the game view where the page says its stage is, or out of sight. */
function placeGame(/** @type {unknown} */ value) {
  const bounds = gameBounds(value)
  if (!game) return
  game.setVisible(bounds.visible)
  if (bounds.visible) game.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
  gameAt = bounds.visible ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null
  placeTrail()
}

/**
 * The pointer's trail: a transparent window over the game view that takes no
 * input — every click goes through to the game — and draws what the core says
 * of autoplay's pointer. A window of the shell's own, so nothing is added to
 * the game's page. It exists while the option is on, and shows while the game
 * view does.
 */
function placeTrail() {
  if (!options.pointer_trail || !window || !game) {
    trail?.destroy()
    trail = null
    return
  }
  if (!gameAt) {
    trail?.hide()
    return
  }
  trail ??= createTrail(window)
  trail.setBounds(trailBounds(window.getContentBounds(), gameAt))
  if (!trail.isVisible()) trail.showInactive()
}

/** @param {BaseWindow} owner */
function createTrail(owner) {
  const view = new BrowserWindow({
    parent: owner,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: { preload: path.join(HERE, 'trail-preload.cjs'), sandbox: true, contextIsolation: true },
  })
  view.setIgnoreMouseEvents(true)
  const page = view.webContents
  page.setWindowOpenHandler(() => ({ action: 'deny' }))
  page.on('will-navigate', event => event.preventDefault())
  void view.loadFile(path.join(HERE, 'trail.html'))
  return view
}

function running() {
  if (!core) throw new Error('The core is not running.')
  return core
}

/**
 * What the interface can ask for. The commands and their arguments are the ones
 * the page uses under any host (`frontend/src/routes/Monitor.tsx`); the ones
 * about the window are answered here, and the rest are the core's.
 * @type {Record<string, (args: Record<string, unknown>) => Promise<unknown>>}
 */
const commands = {
  get_monitor: () => running().call('get_monitor'),
  get_hand_events: ({ round }) => running().call('get_hand_events', { round: Number(round) }),
  get_history: () => running().call('get_history'),
  get_monitor_options: async () => options,
  set_monitor_autoplay: ({ enabled }) => running().call('set_monitor_autoplay', { enabled: enabled === true }),
  async set_monitor_trail({ enabled }) {
    const saved = /** @type {{ pointer_trail: boolean }} */ (await running().call('set_monitor_trail', { enabled: enabled === true }))
    options = { ...options, ...saved }
    placeTrail()
    return options
  },
  async set_monitor_pinned({ pinned }) {
    const saved = /** @type {{ always_on_top: boolean }} */ (await running().call('set_monitor_pinned', { pinned: pinned === true }))
    options = { ...options, ...saved }
    window?.setAlwaysOnTop(options.always_on_top)
    return options
  },
  async resize_monitor_game({ bounds }) {
    placeGame(bounds)
  },
  async open_monitor_game({ bounds }) {
    gameBounds(bounds)
    if (game || !window) return
    const view = game = createGame()
    window.contentView.addChildView(view)
    placeGame(bounds)
    try {
      // The view starts blank; the core sends it to the game once it is listening.
      await view.webContents.loadURL('about:blank')
      await running().call('open_game', { port: cdpPort, target: await targetOf(view) })
    } catch (error) {
      if (game === view) game = null
      window?.contentView.removeChildView(view)
      view.webContents.close()
      throw error
    }
  },
}

/**
 * Before Electron is ready: the switches and the scheme it reads as it starts.
 * The entry module is waited for only as long as it has work pending, so the
 * one thing this waits on — finding a free port — is done in time.
 */
async function prepare() {
  // The game sees an ordinary Chromium: no application's name in the user agent.
  const named = new RegExp(` (Electron|${app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})/\\S+`, 'g')
  app.userAgentFallback = app.userAgentFallback.replace(named, '')
  cdpPort = Number(option('cdp-port')) || await freePort()
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort))
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => { quitting = true })
  app.on('will-quit', () => core?.close())

  ipcMain.handle('akagi:invoke', async (event, command, args) => {
    try {
      if (!dock || event.sender !== dock.webContents) throw new Error('Only the interface can ask this.')
      const run = Object.hasOwn(commands, command) ? commands[command] : null
      if (!run) throw new Error(`Unknown command: ${command}`)
      return { ok: true, value: await run(args && typeof args === 'object' ? args : {}) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** Once Electron is ready: start the core, and open the window when the core is ready too. */
async function start() {
  // No menu bar under the title; macOS keeps the application menu it expects.
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null)
  serveDock()

  const child = core = new Core(CORE, ['--home', DATA], { cwd: DATA })
  child.on('event', (name, payload) => {
    // The pointer's marks are the trail's alone, and come many a second.
    if (name === 'pointer') trail?.webContents.send('trail:mark', payload)
    else dock?.webContents.send('akagi:event', name, payload)
  })
  child.on('exit', reason => fail('Akagi has stopped.', `${reason}\n\n${lastWords()}`))
  try {
    openWindow(await child.ready)
  } catch (error) {
    fail('Akagi could not start.', `${error instanceof Error ? error.message : error}\n${CORE}\n\n${lastWords()}`)
  }
}

fs.mkdirSync(DATA, { recursive: true })
app.setPath('userData', path.join(DATA, 'browser'))
if (app.requestSingleInstanceLock()) {
  await prepare()
  // Not awaited: Electron is not ready until this module has run to its end.
  void app.whenReady().then(start)
} else {
  // The profile belongs to the instance already running, which comes forward instead.
  app.exit(0)
}
