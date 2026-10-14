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

## Streaming the game

With `stream_output` on, the shell offers the game view to a streaming program
on the same computer — the game alone: not the dock, not the pointer's trail,
not the system cursor (`src/stream.js`):

```text
http://127.0.0.1:<port>/<token>/              a page that shows the stream filling its window, for a browser source
http://127.0.0.1:<port>/<token>/stream.mjpg   the frames themselves, as Motion JPEG
```

The token is a random secret: without it every address is a 404, and a request
under any host name but `127.0.0.1` or `localhost` is refused. The port and the
token are kept in the configuration, so the address stays the same from run to
run; the settings tab shows it and copies it.

Frames are made only while something watches (`src/frames.js`): screenshots of
the game view, up to 30 a second, of exactly what it shows — its own size in
screen pixels. Nothing about the game's page is changed to take them: not its
scale, not its size, so the window looks the same and every position autoplay
clicks at stays where it is. A stream wants 1920 × 1080; a game view with fewer
pixels than that is scaled up by the page that shows it. (Telling the page it
is on a denser screen would draw more pixels, but it changes the page while it
is played: its device pixel ratio, and after a move to a screen of another
scale even its layout.)

In OBS, add a **Browser** source with the address, 1920 × 1080. The page picks
the stream up again by itself when the application restarts. A Media source
can open `stream.mjpg` too, but Motion JPEG carries no timing, and ffmpeg
plays it at 25 frames a second whatever comes in.

### Pages of your own beside the game

For overlays and control pages around the game, the same server says what the
table is doing and serves a folder of your own pages (`src/feed.js`,
`src/pages.js`):

```text
http://127.0.0.1:<port>/<token>/feed        server-sent events: `state` (the table, on every change) and `results` (the games on record)
http://127.0.0.1:<port>/<token>/feed.json   the same two, once: {"state": …, "results": […]}
http://127.0.0.1:<port>/<token>/pages/…     the files in <data>/stream-pages/, a folder's index.html for the folder
```

The feed is what anyone watching the table could see, and nothing about the
bot: `state` has the names, our seat, the round (wind, hand, honba, sticks,
dealer), each seat's score and riichi, the dora indicators, and how each hand
of this game ended with the hands shown when it did; `results` has the games on
record — scores, placements, rank points, per-game counts and yaku — without
the path of their logs or the ids that lead to a replay. No decision, no
candidate, nothing a bot said of itself, and not whether autoplay is on. Every
field is named in `src/feed.js`; one the core adds later stays out until it is
named there. `state.version` goes up when a field changes meaning or goes away.

The pages folder is yours: put a page there and add it to the streaming
program as a browser source (an overlay) or as a custom browser dock (a
control page). Its pages may load their own files and open a WebSocket to a
program on this computer (`ws://127.0.0.1:*`, OBS's remote control), and
nothing else. Names with `..` or a leading dot are refused; a link inside the
folder, such as a junction to a music library, is followed. Media files answer
range requests, so audio and video can seek. A page under `pages/` finds the
feed at the top of its own address: `/<token>/feed`.

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
npm test        # the window's geometry, the content policy, the stream's server, frames, feed and pages, and the shell's end of the protocol against a stand-in core
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
