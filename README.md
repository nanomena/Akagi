# Akagi — the one-window build

Mahjong Soul in one window on Windows, Linux and macOS: the game on a 16:9
stage, and under it a dock that shows what a mjai bot makes of every turn —
its suggestion, the candidates it weighed, and whether the game then did what
it said. With autoplay on, the suggestion is played.

This tree began as a fork of [Akagi](https://github.com/shinkuan/Akagi) v3 and
keeps its core: the Mahjong Soul protocol bridge, the game tracker, the bot
manager and autoplay. Akagi's own application — the Tauri windows, the
dashboard and settings pages, the MITM and launched-browser capture modes, the
updater — is not here. What replaced it is a desktop shell with a Chromium of
its own, because capture and autoplay both go through the Chrome DevTools
Protocol and only a Chromium speaks it.

## The three parts

| Part | Where | What it does |
| --- | --- | --- |
| Shell | [`desktop/`](./desktop/) | The window, the game view and the interface view in it, and the local DevTools port. Electron. Nothing about mahjong. |
| Core | `src/`, built as `akagi-core` | Capture from the game view, the bridge, the tracker, the bot and its service, autoplay, and the monitor snapshot. Rust. No window. |
| Interface | [`frontend/`](./frontend/) | One page: the dock, drawn from the core's snapshot. React. |

The shell starts the core as a child process and talks to it in JSON lines over
the child's stdin and stdout ([`src/headless/mod.rs`](./src/headless/mod.rs)
documents the protocol). The core lives exactly as long as that stdin is open.
[`desktop/README.md`](./desktop/README.md) has the rest: how the game view is
isolated, where data is kept, and what is known not to be perfect.

## Running it from a checkout

Rust (stable), Node 22 and `protoc` on `PATH`.

```sh
cargo build --release --bin akagi-core                 # the core
(cd frontend && npm ci && npm run build)               # the interface -> frontend/dist
cd desktop && npm ci
node node_modules/electron/install.js                  # fetch Electron itself, once
npm start
```

To package it for the machine it is built on — Electron, the shell, the core
with a Python runtime beside it, and the interface, in one folder:

```sh
bash scripts/fetch-runtime.sh                          # python + uv -> runtime/
(cd desktop && npm run package)                        # -> dist/desktop/Akagi-<platform>-<arch>/
```

The `Desktop` workflow does this on Linux, macOS and Windows and uploads each
folder as an artifact. Nothing is signed; `desktop/README.md` says what that
means on macOS and Linux.

## Bots

A bot is a folder under `mjai_bot/` in the data folder: a `bot.py` that speaks
mjai on stdin and stdout, a `manifest.toml`, and optionally a long-running
service the core starts and stops with the application.
[`mjai_bot/README.md`](./mjai_bot/README.md) is the contract for writing one,
[`src/bot/README.md`](./src/bot/README.md) how the core runs them and what a
bot can say about itself in the dock. A built-in bot needs no install and is
the default.

The dock knows the game and the mjai actions, and nothing about any bot: the
numbers and words a bot wants shown arrive in its replies and are shown as
written.

## Versions and upstream

This tree has a version line of its own, starting at 0.1.0. Akagi is something
it carries, the way a distribution carries a kernel: the two are versioned
apart, and what ties them together is written down rather than read off a
number.

- **`main`** is this tree.
- **`upstream`** mirrors Akagi's `v3` as it is. It only ever fast-forwards;
  nothing is committed to it.
- **`[package.metadata.upstream]`** in `Cargo.toml` records the Akagi version
  and commit this tree has been followed to.

Upstream is followed for what it knows about the games — the bridges under
`src/bridge/` and the autoplay beside them — and is backported from, not
rebased onto:

```sh
git fetch upstream && git push origin upstream/v3:upstream    # move the mirror
git diff <recorded commit> upstream -- src/bridge src/autoplay  # what changed there since
```

Bring over what applies on a branch off `main`, then move the recorded commit
forward in the same change.

Mahjong Soul's protocol *definitions* need none of that
(`src/bridge/majsoul/proto/liqi.proto`, `liqi.json`): they are rebuilt from the
live client by [`scripts/extract_liqi.py`](./scripts/extract_liqi.py), which the
`Auto Liqi` workflow runs daily, opening a pull request when they move.

The bridges for Tenhou and Riichi City are carried as well. The application
opens only Mahjong Soul today; they are kept for when it opens the others.

## Layout

```text
.
├── desktop/           the shell: window, views, DevTools port, packaging
├── frontend/          the interface: the monitor page
├── src/
│   ├── headless/      the core's boot and its protocol with the shell
│   ├── capture/       capture from the game view over CDP
│   ├── bridge/        game protocol → mjai events
│   ├── game_state/    the tracker: a mirror of the game from its events
│   ├── monitor/       the snapshot the dock draws
│   ├── bot/           bot manager, mjai subprocess runner, bot services, built-in bot
│   ├── autoplay/      a bot's decision → input in the game view
│   ├── history/       finished games, one file each
│   ├── config/        config.toml
│   ├── logger/        one folder of logs per run
│   └── bin/           akagi-core
├── native_bot/        the built-in bot
├── mjai_bot/          bots that ship in the tree
├── scripts/           Python runtime fetch, protocol extraction
└── tests/             integration tests
```

Per-module guides live in each `src/*/README.md`.

## Checks

```sh
cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test
(cd frontend && npm run lint && npm test && npm run build)
(cd desktop && npm run check && npm test && npm run smoke)   # smoke needs a display
```

## License and attribution

Licensed under the [Apache License 2.0](./LICENSE.txt). The core is Akagi v3's,
copyright 2026 Shinkuan. Third-party attributions are in [`NOTICE`](./NOTICE);
per Apache-2.0 §4(d), redistributions must include both files.

- **riichienv-core** / RiichiEnv (Apache-2.0) — Cargo dependency.
- **mahgen** (MIT) — draws the tile faces.
- **Majsoul-to-NAGA**, adapted from **majsoul-naga** (MIT) — the conversion of
  an opened replay to a tenhou.net/6 log.
- **MajsoulMax-rs** (GPL-3.0), the **mjai** specification (Gimite) and
  **mjai.app** — reference only, no code copied; listed in `NOTICE` for credit.

## Acknowledgements

- [Akagi](https://github.com/shinkuan/Akagi) by Shinkuan, and its
  predecessors [Akagi v2](https://github.com/shinkuan/Akagi/tree/v2) and
  [AkagiNG](https://github.com/Xe-Persistent/Akagi-NG) — this build stands on
  their work.
- [`mjai.app`](https://github.com/smly/mjai.app) and the mjai specification by
  Gimite — the protocol that makes pluggable bots possible.
