// The whole of what the pointer's trail can reach of the shell: the marks it is
// sent. Nothing goes the other way. Sandboxed preload scripts are CommonJS and
// see only `electron`.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('trail', {
  /** @param {(mark: { x: number, y: number, down: boolean }) => void} listener */
  onMark(listener) {
    ipcRenderer.on('trail:mark', (_event, mark) => listener(mark))
  },
})
