import { renderThread } from './pages-thread.js';
import { forkForm, scopeFields } from './pages.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const shell = (title, content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/assets/app.css"></head><body><header><a href="/">See / Spec / Send</a> <a href="/search">Search</a></header><main>${content}</main><script src="/assets/app.js" defer></script></body></html>`;

export function specPage(item, events, person) {
  const context = item.context;
  const specs = events.filter(event => event.type === 'specced');
  const current = specs.at(-1);
  if (!current) return shell('Spec', '<p><a href="/">Back to the work</a></p><p>No spec has been written yet.</p>');
  const own = context.steward === person;
  const fields = key => escape((current[key] || []).join('\n'));
  const update = own && !['HELPS', 'SHELVED'].includes(item.state) ? `<form data-event="specced"><h2>Update the spec</h2><input type="hidden" name="see_hash" value="${escape(context.seeHash)}"><label>Must do<textarea name="must" required>${fields('must')}</textarea></label><label>How we'll know<textarea name="how_we_know" required>${fields('how_we_know')}</textarea></label><label>Out of scope<textarea name="out_of_scope">${fields('out_of_scope')}</textarea></label>${scopeFields(current.scope)}<button>Save Spec update</button></form>` : '';
  const send = own && item.state === 'SPECCED' ? `<form data-research="true"><p>${item.workspaceResearch ? 'Workspace research is connected. Other sources remain disconnected.' : "Research sources aren't connected. An operator can enable workspace research."} Refreshing records exactly what was and wasn't checked.</p><button>Refresh research record</button></form><form data-send="true"><input type="hidden" name="spec_hash" value="${escape(context.specHash)}"><label>Your cost and time estimate (optional, not independently verified)<textarea name="estimate" maxlength="2000"></textarea></label><button>SEND IT!</button></form>` : '';
  const scope = current.scope || { data_sources: [], audiences: [] };
  const scopeSummary = `<section><h2>Proposed scope</h2><p>Data sources: ${scope.data_sources.length ? scope.data_sources.map(escape).join(', ') : 'none'}. Audiences: ${scope.audiences.length ? scope.audiences.map(escape).join(', ') : 'none'}. These IDs describe the proposal; they don't connect a source or grant access.</p></section>`;
  const versions = specs.map((spec, index) => `<li>Spec v${index + 1}${spec.body_hash === context.specHash ? ' (current)' : ''}</li>`).join('');
  const research = events.filter(event => event.type === 'researched').at(-1);
  const researchView = research ? `<section><h2>Research record</h2><p>Recorded by ${escape(research.actor)} on ${escape(research.at)}. This snapshot may become outdated.</p><ul>${Object.entries(research.sources).map(([source, entry]) => `<li>${escape(source)}: ${escape(entry.status)}. ${escape(entry.finding)}${entry.checkedAt ? ` (recorded at ${escape(entry.checkedAt)})` : ' (never checked)'}</li>`).join('')}</ul></section>` : '<p>Research: no sources connected, nothing checked.</p>';
  const comment = `<form data-event="commented"><h2>Talk about this spec</h2><label>Comment<textarea name="comment" required maxlength="4000"></textarea></label><input type="hidden" name="kind" value="comment"><input type="hidden" name="anchor_kind" value="spec"><input type="hidden" name="anchor_hash" value="${escape(context.specHash)}"><button>Post comment</button></form>`;
  return shell('Spec', `<p><a href="/items/${encodeURIComponent(item.id)}">Back to SEE</a></p><h1>Spec v${escape(context.specVersion)}</h1><h2>Versions</h2><ol>${versions}</ol><h2>Must do</h2><ul>${current.must.map(value => `<li>${escape(value)}</li>`).join('')}</ul><h2>How we'll know</h2><ul>${current.how_we_know.map(value => `<li>${escape(value)}</li>`).join('')}</ul>${scopeSummary}${researchView}${update}${send}${forkForm(events, context)}${comment}<h2>Spec thread</h2>${renderThread(events, { ...context, steward: own ? context.steward : null }, 'spec') || '<p>No comments yet.</p>'}`);
}
