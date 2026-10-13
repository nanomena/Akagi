// The whole of what the interface can reach of the shell: commands by name, and
// events by name. Sandboxed preload scripts are CommonJS and see only `electron`.
const { contextBridge, ipcRenderer } = require('electron')

/** @type {Map<string, Set<(payload: unknown) => void>>} */
const listeners = new Map()
ipcRenderer.on('akagi:event', (_event, name, payload) => {
  for (const listener of listeners.get(name) ?? []) listener(payload)
})

contextBridge.exposeInMainWorld('akagi', {
  /**
   * Rejects with the message itself, the way the interface shows it.
   * @param {string} command
   * @param {Record<string, unknown>} [args]
   */
  async invoke(command, args) {
    const reply = await ipcRenderer.invoke('akagi:invoke', command, args ?? {})
    if (reply.ok) return reply.value
    throw reply.error
  },
  /**
   * @param {string} name
   * @param {(payload: unknown) => void} listener
   * @returns {() => void} stop listening
   */
  listen(name, listener) {
    const named = listeners.get(name) ?? new Set()
    listeners.set(name, named.add(listener))
    return () => { named.delete(listener) }
  },
})
