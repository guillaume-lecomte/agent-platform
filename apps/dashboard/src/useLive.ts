import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeConnection, subscribeEvents } from './events.js';

/**
 * Loads data with `load` and reloads it whenever the API reports a task event, plus every
 * `fallbackMs` in case the event stream drops.
 */
export function useLive<T>(
  load: () => Promise<T>,
  options: { fallbackMs?: number } = {},
): { data: T | undefined; error: string | undefined; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const loadRef = useRef(load);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    loadRef.current = load;
  });

  const reload = useCallback(() => {
    clearTimeout(timer.current);
    // Events come in bursts (one per step); coalesce them into a single request.
    timer.current = setTimeout(() => {
      loadRef
        .current()
        .then((d) => {
          setData(d);
          setError(undefined);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, 120);
  }, []);

  const fallbackMs = options.fallbackMs ?? 10_000;
  useEffect(() => {
    reload();
    const unsubscribe = subscribeEvents(reload);
    const poll = setInterval(reload, fallbackMs);
    return () => {
      unsubscribe();
      clearInterval(poll);
      clearTimeout(timer.current);
    };
  }, [reload, fallbackMs]);

  return { data, error, reload };
}

/** Whether the shared event stream is currently connected. */
export function useConnected(): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => subscribeConnection(setConnected), []);
  return connected;
}
