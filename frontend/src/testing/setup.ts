import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Vitest runs with `globals: false`, so Testing Library's auto-cleanup (which
// hooks a global `afterEach`) never registers. Do it explicitly.
afterEach(cleanup)

// jsdom ships no ResizeObserver, which the monitor page uses to follow its stage.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
