import { useEffect, useState } from 'react'
import { invoke, listen } from '@/lib/tauri'
import { newestSnapshot, type MonitorSnapshot } from '@/lib/monitor'

export function useMonitor() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    const apply = (s: MonitorSnapshot) => { if (!cancelled) setSnapshot(current => newestSnapshot(current, s)) }
    void (async () => {
      try {
        const stop = await listen<MonitorSnapshot>('monitor-updated', apply)
        if (cancelled) { stop(); return }
        unlisten = stop
        apply(await invoke<MonitorSnapshot>('get_monitor'))
      } catch (e) { if (!cancelled) setError(String(e)) }
    })()
    return () => { cancelled = true; unlisten?.() }
  }, [])
  return { snapshot, error }
}
