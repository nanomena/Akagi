import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event'

const TAURI_GLOBAL = (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__
export const HAS_TAURI = TAURI_GLOBAL !== undefined

/**
 * The desktop shell's bridge (`desktop/src/preload.cjs`), when the page runs
 * there instead of in a Tauri window. Same commands, same events: whichever
 * host is present answers `invoke` and `listen`.
 */
type ShellBridge = {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
  listen(name: string, cb: (payload: unknown) => void): () => void
}
const SHELL = (globalThis as unknown as { akagi?: ShellBridge }).akagi

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (SHELL) return await SHELL.invoke(cmd, args) as T
  if (!HAS_TAURI) throw new Error(`tauri not available: ${cmd}`)
  return await tauriInvoke<T>(cmd, args)
}

export async function listen<T>(
  name: string,
  cb: (payload: T) => void,
): Promise<UnlistenFn> {
  if (SHELL) return SHELL.listen(name, payload => cb(payload as T))
  if (!HAS_TAURI) return () => {}
  return await tauriListen<T>(name, (e) => cb(e.payload))
}
