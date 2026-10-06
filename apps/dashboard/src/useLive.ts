import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskEvent } from './types.js';

/**
 * Loads data with `load`, and reloads it whenever the API emits a task event (server-sent
 * events), plus every `fallbackMs` as a safety net if the stream drops.
 */
export function useLive<T>(
  load: () => Promise<T>,
  options: { fallbackMs?: number; onEvent?: (e: TaskEvent) => void } = {},
): { data: T | undefined; error: string | undefined; reload: () => void; connected: boolean } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      loadRef
        .current()
        .then((d) => {
          setData(d);
          setError(undefined);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, 120); // coalesce bursts of events into one refresh
  }, []);

  useEffect(() => {
    reload();
    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (m: MessageEvent<string>) => {
      try {
        onEventRef.current?.(JSON.parse(m.data) as TaskEvent);
      } catch {
        // ignore malformed events
      }
      reload();
    };
    const poll = setInterval(reload, options.fallbackMs ?? 10_000);
    return () => {
      source.close();
      clearInterval(poll);
      clearTimeout(timer.current);
    };
  }, [reload, options.fallbackMs]);

  return { data, error, reload, connected };
}
