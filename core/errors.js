// Typed failures. Every expected outcome is raised as one of these kinds, and app/http.js maps
// each kind to one status. A plain Error is a bug: it answers 500 with a request ID and logs the stack.
// The message is never used to pick a status.
export class AppError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
  }
}

// A rule said no: approval, stale state, cap, replay, wrong stage. Answers 409.
export const refused = message => new AppError('refused', message);
// The input is malformed or the account and invite are unusable. Answers 400.
export const invalid = message => new AppError('invalid', message);
// The request is larger than the fixed limit. Answers 413.
export const tooLarge = message => new AppError('too_large', message);

// SQLite lock contention is a retryable server state, never a rule refusal.
const contention = error => error?.errcode === 5 || error?.errcode === 6;

export const kindOf = error => {
  if (error instanceof AppError) return error.kind;
  if (contention(error)) return 'busy';
  return 'bug';
};
