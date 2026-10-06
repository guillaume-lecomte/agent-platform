import type { TaskEvent } from './types.js';

type Listener = (event: TaskEvent) => void;
type StatusListener = (connected: boolean) => void;

const listeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();
let source: EventSource | undefined;
let connected = false;

function setConnected(value: boolean): void {
  connected = value;
  for (const l of statusListeners) l(value);
}

/**
 * One EventSource for the whole page, shared by every component that wants live updates.
 * Browsers allow only six HTTP/1.1 connections per origin; one stream per component would
 * quickly starve ordinary requests.
 */
function ensureSource(): void {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false);
  source.onmessage = (m: MessageEvent<string>) => {
    let event: TaskEvent;
    try {
      event = JSON.parse(m.data) as TaskEvent;
    } catch {
      return;
    }
    for (const l of listeners) l(event);
  };
}

function releaseSource(): void {
  if (listeners.size > 0 || statusListeners.size > 0) return;
  source?.close();
  source = undefined;
  setConnected(false);
}

export function subscribeEvents(listener: Listener): () => void {
  listeners.add(listener);
  ensureSource();
  return () => {
    listeners.delete(listener);
    releaseSource();
  };
}

export function subscribeConnection(listener: StatusListener): () => void {
  statusListeners.add(listener);
  ensureSource();
  listener(connected);
  return () => {
    statusListeners.delete(listener);
    releaseSource();
  };
}
