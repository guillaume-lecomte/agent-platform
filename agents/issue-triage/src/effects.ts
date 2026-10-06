import type pg from 'pg';

export interface Effect {
  /** Key of the tool call that produced it (task + step + argument hash). */
  idempotencyKey: string;
  taskId: string | undefined;
  tool: 'add_labels' | 'post_comment';
  issueNumber: number;
  payload: Record<string, unknown>;
}

/**
 * Where the simulated "GitHub" records the effects tools perform. It intentionally has no
 * uniqueness constraint: if the platform ever executed an effect twice, the duplicate
 * would show up here, which is what the crash demo checks.
 */
export interface EffectLog {
  record(effect: Effect): Promise<void>;
  list(filter?: { taskId?: string }): Promise<Effect[]>;
}

export class InMemoryEffectLog implements EffectLog {
  readonly effects: Effect[] = [];

  record(effect: Effect): Promise<void> {
    this.effects.push(effect);
    return Promise.resolve();
  }

  list(filter: { taskId?: string } = {}): Promise<Effect[]> {
    return Promise.resolve(
      this.effects.filter((e) => (filter.taskId ? e.taskId === filter.taskId : true)),
    );
  }
}

export class PgEffectLog implements EffectLog {
  private ready: Promise<unknown> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  private init(): Promise<unknown> {
    this.ready ??= this.pool.query(`
      create table if not exists sandbox_effects (
        id bigserial primary key,
        idempotency_key text not null,
        task_id text,
        tool text not null,
        issue_number integer not null,
        payload jsonb not null,
        created_at timestamptz not null default now()
      )`);
    return this.ready;
  }

  async record(effect: Effect): Promise<void> {
    await this.init();
    await this.pool.query(
      'insert into sandbox_effects (idempotency_key, task_id, tool, issue_number, payload) values ($1,$2,$3,$4,$5)',
      [
        effect.idempotencyKey,
        effect.taskId ?? null,
        effect.tool,
        effect.issueNumber,
        effect.payload,
      ],
    );
  }

  async list(filter: { taskId?: string } = {}): Promise<Effect[]> {
    await this.init();
    const res = await this.pool.query<{
      idempotency_key: string;
      task_id: string | null;
      tool: Effect['tool'];
      issue_number: number;
      payload: Record<string, unknown>;
    }>(
      `select idempotency_key, task_id, tool, issue_number, payload from sandbox_effects
       ${filter.taskId ? 'where task_id = $1' : ''} order by id`,
      filter.taskId ? [filter.taskId] : [],
    );
    return res.rows.map((r) => ({
      idempotencyKey: r.idempotency_key,
      taskId: r.task_id ?? undefined,
      tool: r.tool,
      issueNumber: r.issue_number,
      payload: r.payload,
    }));
  }
}
