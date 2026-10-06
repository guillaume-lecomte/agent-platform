export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

/** The requested transition is not valid in the current state (e.g. deciding twice). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * Another worker appended the step we were about to write. The task is being advanced
 * elsewhere (a duplicate job, or a lock lost to a stalled worker); this run stops quietly.
 */
export class StepConflictError extends Error {
  constructor(taskId: string, seq: number) {
    super(`step ${seq} of task ${taskId} was already written`);
    this.name = 'StepConflictError';
  }
}
