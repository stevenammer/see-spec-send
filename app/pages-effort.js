const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function renderEffortStatus(jobs) {
  const statuses = { queued: 'queued, waiting for a worker', running: 'thinking', blocked: 'blocked, not retrying', failed: 'unavailable, retries exhausted', done: 'answered' };
  return (jobs || []).map(job => job.state === 'running' && ['provider status/usage unknown; charged hold retained; awaiting reconciliation', 'gateway disabled or stopped; awaiting resume'].includes(job.last_error)
    ? `<p>Effort: ${escape(job.kind)}: ${escape(job.last_error)}.</p>`
    : `<p>Effort: ${escape(job.kind)} is ${escape(statuses[job.state] || job.state)}${job.last_error ? ` (${escape(job.last_error)})` : ''}.</p>`).join('') || '<p>Effort is not turned on on this server.</p>';
}
