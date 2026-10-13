import { useEffect, useState } from 'react'
import { invoke, listen } from '@/lib/host'
import { newestSnapshot, type MonitorSnapshot } from '@/lib/monitor'

export function useMonitor() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const apply = (s: MonitorSnapshot) => { if (!cancelled) setSnapshot(current => newestSnapshot(current, s)) }
    // Listening first: a state that arrives while the first one is being
    // fetched is not lost, and the older of the two is the one dropped.
    const stop = listen<MonitorSnapshot>('monitor-updated', apply)
    invoke<MonitorSnapshot>('get_monitor').then(apply, e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true; stop() }
  }, [])
  return { snapshot, error }
}
