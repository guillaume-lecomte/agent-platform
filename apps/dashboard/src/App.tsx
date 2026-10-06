import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ApprovalsPage } from './pages/ApprovalsPage.js';
import { CostsPage } from './pages/CostsPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { useLive } from './useLive.js';

type Route = 'tasks' | 'approvals' | 'costs';

const parse = (hash: string): Route => {
  const r = hash.replace(/^#\/?/, '');
  return r === 'approvals' || r === 'costs' ? r : 'tasks';
};

export function App() {
  const [route, setRoute] = useState<Route>(parse(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const pending = useLive(() => api.approvals('pending'));
  const waiting = pending.data?.length ?? 0;

  const link = (to: Route, label: string, badge?: number) => (
    <a
      href={`#/${to}`}
      className={route === to ? 'active' : undefined}
      aria-current={route === to ? 'page' : undefined}
    >
      {label}
      {badge ? <span className="count">{badge}</span> : null}
    </a>
  );

  return (
    <>
      <header className="top">
        <strong className="brand">agent-platform</strong>
        <nav>
          {link('tasks', 'Tasks')}
          {link('approvals', 'Approvals', waiting)}
          {link('costs', 'Costs & latency')}
        </nav>
        <span
          className={`live ${pending.connected ? 'on' : 'off'}`}
          title="Server-sent events stream"
        >
          {pending.connected ? 'live' : 'reconnecting…'}
        </span>
      </header>
      <main>
        {route === 'tasks' && <TasksPage />}
        {route === 'approvals' && <ApprovalsPage />}
        {route === 'costs' && <CostsPage />}
      </main>
      <footer>No authentication: this is a proof of concept meant to run on your machine.</footer>
    </>
  );
}
