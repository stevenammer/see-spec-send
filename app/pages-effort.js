const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// What a person reads in place of a stored reason. Anything not listed is shown as it was recorded.
const reasons = { 'post superseded, not answered': 'this stage was closed before Effort could answer, so it was skipped' };

export function renderEffortStatus(jobs) {
  const statuses = { queued: 'waiting to start', running: 'thinking', blocked: 'blocked, not retrying', failed: 'unavailable, retries exhausted', done: 'replied (see the thread)' };
  const kinds = { see_first: 'first reply to the SEE', spec_first: 'first reply to the SPEC', spec_draft: 'SPEC draft', tag: 'reply to a mention', spec_prepare: 'SPEC draft' };
  return (jobs || []).map(job => job.state === 'running' && ['provider status/usage unknown; charged hold retained; awaiting reconciliation', 'gateway disabled or stopped; awaiting resume'].includes(job.last_error)
    ? `<p>Effort (the AI), ${escape(kinds[job.kind] || job.kind)}: ${escape(job.last_error)}.</p>`
    : `<p>Effort (the AI), ${escape(kinds[job.kind] || job.kind)}: ${escape(statuses[job.state] || job.state)}${job.last_error ? ` (${escape(reasons[job.last_error] || job.last_error)})` : ''}.</p>`).join('') || '<p>Effort is not turned on on this server.</p>';
}
