/**
 * The page's way to the application it runs in: the bridge the desktop shell
 * puts on `window` (`desktop/src/preload.cjs`). Commands by name, events by
 * name; the shell answers the ones about the window and hands the rest to the
 * core.
 *
 * Opened in a plain browser there is no shell: commands fail and no event ever
 * arrives, and the page shows that it has no connection.
 */
type ShellBridge = {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
  listen(name: string, cb: (payload: unknown) => void): () => void
}
const SHELL = (globalThis as unknown as { akagi?: ShellBridge }).akagi

/** Rejects with the message itself, as the shell and the core word it. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!SHELL) throw new Error(`No application to ask: ${cmd}`)
  return await SHELL.invoke(cmd, args) as T
}

/** Returns the way to stop listening. */
export function listen<T>(name: string, cb: (payload: T) => void): () => void {
  return SHELL ? SHELL.listen(name, payload => cb(payload as T)) : () => {}
}
