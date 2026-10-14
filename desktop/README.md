# Akagi's desktop shell

One window on Windows, Linux and macOS: the game on a 16:9 stage and the
monitor's dock under it, 4:3 in all.

Capture and autoplay both go through the Chrome DevTools Protocol, and of the
webviews an operating system provides only Windows' is a Chromium. This shell
brings its own Chromium (Electron), so there is one capture path and one input
path on every platform.

## The three parts

| Part | Where | What it does |
| --- | --- | --- |
| Shell | `desktop/` | The window, the two views in it, and the local DevTools port. Nothing about mahjong. |
| Core | `src/headless`, built as `akagi-core` | Everything else: capture, the bridge, the tracker, the bot, autoplay, the monitor snapshot. No window, no webview. |
| Interface | `frontend/`, the monitor page | Draws the dock from the core's snapshot. |

The shell starts the core as a child process and talks to it in JSON lines over
the child's stdin and stdout; `src/headless/mod.rs` documents the protocol. The
core lives exactly as long as that stdin is open, so there is nothing to clean
up when the shell goes, however it goes.

The interface reaches the shell through two functions the preload script
exposes, `invoke(command, args)` and `listen(event, callback)`
(`frontend/src/lib/host.ts`). The shell answers the commands about the window
itself and passes the rest to the core.

The game is a second view in the same window, in a browser session of its own
(`persist:game`): its cookies and storage are kept between runs and are not
shared with the interface. It has no preload script and no way to reach the
shell. When the page opens it, the shell tells the core the DevTools port and
the view's target id; the core attaches to that one page and sends it to the
game.

Input sent over DevTools shows no cursor, so autoplay's pointer can be drawn
over the game when the settings ask for it (`pointer_trail`). The core then
sends where the pointer goes (`pointer` events) and the shell draws them in a
transparent window of its own over the game view (`src/trail.*`), which takes
no input: clicks pass through it to the game. Nothing is added to the game's
page.

## Running it from a checkout

```sh
cargo build --release --bin akagi-core                         # the core
(cd frontend && npm ci && npm run build)                        # the interface -> frontend/dist
cd desktop && npm ci
node node_modules/electron/install.js                           # fetch Electron itself, once
npm start
```

`npm start` finds the core in `target/release` and the interface in
`frontend/dist`. To point it elsewhere:

| Option | Environment | Default |
| --- | --- | --- |
| `--data=<dir>` | `AKAGI_DATA` | `<appData>/akagi-desktop` |
| `--core=<file>` | `AKAGI_CORE` | the packaged core, or `target/release/akagi-core` |
| `--dock=<dir>` | `AKAGI_DOCK` | the packaged interface, or `frontend/dist` |
| `--cdp-port=<n>` | `AKAGI_CDP_PORT` | any free port |

## Where things are kept

Everything is under the data folder, and nothing is written beside the
executables:

```text
<data>/config.toml    the configuration (created with defaults on first run)
<data>/mjai_bot/      installed bots
<data>/logs/          one folder per run
<data>/history/       finished games
<data>/browser/       the Chromium profile, the game's session included
<data>/window.json    where the window was left
```

## Checks

```sh
npm run check   # type-check the JavaScript (JSDoc types, no build step)
npm test        # the window's geometry, the content policy, and the shell's end of the protocol against a stand-in core
npm run smoke   # the shell for real — Electron, the built interface, a stand-in core — looked at over its DevTools port
```

`npm run smoke` needs a display (`xvfb-run -a npm run smoke` without one) and
runs on Linux and macOS. It is the check that sees whether the page still
draws when served the way the shell serves it: a content policy one directive
short breaks nothing loudly, the tiles just turn into text.

## Packaging

```sh
bash ../scripts/fetch-runtime.sh   # python + uv for this machine -> runtime/
npm run package                    # -> dist/desktop/Akagi-<platform>-<arch>/
```

`scripts/package.mjs` puts Electron, the shell, the core with its Python
runtime, and the interface into one folder that runs from wherever it is put.
The `Desktop` workflow does this on Linux, macOS and Windows and uploads each
as an artifact. Nothing is signed:

- **macOS** quarantines an unsigned application that was downloaded. Clear it
  once after unpacking: `xattr -dr com.apple.quarantine Akagi.app`.
- **Linux** distributions that restrict unprivileged user namespaces
  (Ubuntu 24.04 and later) refuse Chromium's sandbox from an unpacked folder.
  Either give the helper its permissions —
  `sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox` — or start
  the application with `--no-sandbox`.

## Things to know

- **The DevTools port is local and unauthenticated.** It is bound to
  `127.0.0.1`, on a port chosen at start, and it is how the core sees and
  drives the game. Any program running as the same user could connect to it.
- **The game view is never put to sleep.** It keeps drawing and taking input
  while the window is covered or minimized, because autoplay has to keep
  working then.
- **The ES-module entry point must not `await app.whenReady()` at its top
  level.** Electron waits for the entry module to finish before it becomes
  ready, so that wait never ends. `main.js` awaits only what has to happen
  before `ready`, and continues from `whenReady().then(…)`.
- **On Windows the 4:3 lock is approximate while an edge is being dragged** and
  exact when the drag ends: Electron's aspect-ratio lock counts the title bar
  there, so the shell asks for the ratio that suits the current width and
  corrects the size at the end.
