const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function renderEffortStatus(jobs) {
  const statuses = { queued: 'waiting to start', running: 'thinking', blocked: 'blocked, not retrying', failed: 'unavailable, retries exhausted', done: 'replied (see the thread)' };
  const kinds = { see_first: 'first reply to the SEE', spec_first: 'first reply to the SPEC', spec_draft: 'SPEC draft', tag: 'reply to a mention', spec_prepare: 'SPEC draft' };
  return (jobs || []).map(job => job.state === 'running' && ['provider status/usage unknown; charged hold retained; awaiting reconciliation', 'gateway disabled or stopped; awaiting resume'].includes(job.last_error)
    ? `<p>Effort (the AI), ${escape(kinds[job.kind] || job.kind)}: ${escape(job.last_error)}.</p>`
    : `<p>Effort (the AI), ${escape(kinds[job.kind] || job.kind)}: ${escape(statuses[job.state] || job.state)}${job.last_error ? ` (${escape(job.last_error)})` : ''}.</p>`).join('') || '<p>Effort is not turned on on this server.</p>';
}
