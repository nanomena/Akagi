// @ts-check
// A stand-in for the core that speaks its protocol and nothing more, for the
// tests of the shell's end of it. `--mode` picks how it behaves:
//   ok      ready at once; answers `echo`, refuses `refuse`, says `monitor-updated` when asked to `nudge`
//   silent  never says it is ready
//   crash   says it is ready, then exits with status 3 on the first request
// Ends when its stdin closes, as the core does.
import { createInterface } from 'node:readline'

const mode = process.argv[process.argv.indexOf('--mode') + 1] ?? 'ok'
const say = (/** @type {unknown} */ message) => process.stdout.write(JSON.stringify(message) + '\n')

process.stderr.write('stand-in core: starting\n')
if (mode !== 'silent') say({ event: 'ready', payload: { brand: 'Stand-in', monitor: { always_on_top: false }, version: '0.0.0' } })

createInterface({ input: process.stdin }).on('line', line => {
  // Not everything on the line is ours to understand; the core skips what is not a request.
  let request
  try { request = JSON.parse(line) } catch { return }
  if (mode === 'crash') {
    process.stderr.write('stand-in core: giving up\n')
    process.exit(3)
  }
  if (request.method === 'echo') say({ id: request.id, result: request.params })
  else if (request.method === 'nudge') { say({ event: 'monitor-updated', payload: { sequence: 7 } }); say({ id: request.id, result: null }) }
  else say({ id: request.id, error: `unknown method: ${request.method}` })
}).on('close', () => process.exit(0))
