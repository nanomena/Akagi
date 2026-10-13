# The interface

One page: the monitor's dock, with the stage above it that the desktop shell
puts the game on. React, TypeScript and Vite; the page's own CSS, no component
library.

The page draws what the core's monitor snapshot says and nothing else. It
reaches the application through `src/lib/host.ts` — commands by name, events by
name — which the desktop shell answers (`desktop/`). It knows the game and the
mjai actions, and nothing about any bot: what a bot wants shown about itself
arrives as words in the snapshot (see "What a bot says about itself" in
`src/bot/README.md`).

```text
src/
  main.tsx                 mounts the one page
  index.css                the browser's defaults taken down to nothing
  routes/Monitor.tsx       the page: the stage, the dock and its tabs
  routes/Monitor.css       all of its styling; the canvas is laid out once at 1280 × 960 and scaled
  components/monitor/      the decision card and candidates, the table, tiles, diagnostics
  hooks/useMonitor.ts      the snapshot: fetched once, then followed
  lib/monitor.ts           everything the page derives from a snapshot; no React in it
  lib/tileFace.ts          tile faces, drawn once each and cached
  lib/host.ts              the bridge to the shell
  types.ts                 the shapes the core sends
```

Two rules the page keeps:

- **Fixed places.** Every region of the dock has a slot of one size. A state
  changes what a slot shows, never where the slots are, and a tile is one size
  whatever the hand holds.
- **The bot's words as written.** Numbers and captions a bot supplies are shown
  as they are; the page neither rescales nor explains them.

## Commands

```sh
npm ci
npm run build   # type-check, then build into dist/ — what the shell serves
npm test        # vitest
npm run lint
npm run dev     # the page alone in a browser; with no shell it says it has no connection
```
