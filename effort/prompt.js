const SYSTEM = 'You are Effort, an AI thinking partner in See / Spec / Send. Reply with one useful, plain-language comment. You cannot approve, change a post, spend money, or create events.';

// The gateway refuses prompts over its input limit (8,192 bytes by default). The prompt is bounded by entries AND bytes:
// the original (trimmed), then the most recent comments (each trimmed), dropping the oldest until it fits.
// What was left out is counted, so Effort is told the thread is partial.
const MAX_ENTRIES = 20;
const MAX_BYTES = 6000;
const trim = (text, n) => String(text ?? '').slice(0, n);

export function effortPrompt(original, events, { maxBytes = MAX_BYTES } = {}) {
  const comments = events.filter(event => typeof event.comment === 'string')
    .map(event => ({ by: trim(event.actor, 64), kind: trim(event.kind, 16), text: trim(event.comment, 400) }));
  const head = trim(original, 1500);
  let thread = comments.slice(-MAX_ENTRIES);
  const build = () => JSON.stringify({ original: head, thread, omitted_comments: Math.max(0, comments.length - thread.length) });
  while (thread.length > 0 && Buffer.byteLength(build()) > maxBytes) thread = thread.slice(1);
  return Object.freeze({ system: SYSTEM, input: build() });
}
