import { renderEffortStatus } from './pages-effort.js';
import { postedQuestMemo } from '../public/vision-quest.js';
import { renderThread } from './pages-thread.js';
import { lineDiff } from '../core/diff.js';
import { EFFORT_LIMITS } from '../gateway/effort.js';
import { parseSpecDraft, SPEC_DRAFT_PREFIX } from '../effort/spec.js';
import { NOT_BUILT_LABEL } from '../core/machine.js';
const escape = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    char =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );

const stages = {
  SEEN: 'See',
  CHECKED: 'Checked',
  SPECCED: 'Spec',
  SUBMITTED: 'Decide',
  SENDING: 'Send',
  TRYING: 'Send',
  HELPS: 'Helps',
  SHELVED: 'Shelved',
};
const decisionLabels = {
  approved: 'Approve bounded experiment', returned: 'Return for revision (legacy outcome)',
  not_built: `${NOT_BUILT_LABEL} (legacy outcome)`, return_for_revision: 'Return', defer: 'Defer',
  redirect: 'Redirect', resolve_without_build: 'Resolve without build', decline: 'Decline',
  prohibited: 'Prohibited', experiment_did_not_help: 'Experiment did not help', op_withdrew: 'Original poster withdrew',
};
const reflectionLinks = event => ['evidence', 'annexes', 'results'].flatMap(field => Array.isArray(event?.[field]) ? event[field] : [])
  .filter(row => row && typeof row.url === 'string' && /^https?:\/\//.test(row.url))
  .map(row => ({ url: row.url, label: typeof row.claim === 'string' ? row.claim : 'Record link' }));
const reflectionRecord = (item, events, person) => {
  const decisionAt = events.findIndex(event => ['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew'].includes(event.type));
  const known = events.slice(0, decisionAt < 0 ? events.length : decisionAt + 1).flatMap(reflectionLinks);
  const later = decisionAt < 0 ? [] : events.slice(decisionAt + 1).filter(event =>
    ['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'helped', 'tried'].includes(event.type) ||
    ['annexes', 'results'].some(field => Array.isArray(event[field]) && event[field].length));
  const changed = later.flatMap(reflectionLinks);
  const record = { person, item: item.id, known, changed,
    later: later.map(event => event.body_hash || `${event.type}:${event.at || ''}`) };
  record.changeKey = JSON.stringify({ changed, later: record.later });
  return record;
};
const shell = (title, content, { signedOut = false } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/assets/app.css"></head><body><header><a href="/">See / Spec / Send</a>${signedOut ? '' : ' <a href="/search">Search</a> <a href="/intelligence">Investigate</a> <a href="/mentoring">Mentoring</a> <button type="button" class="linklike" data-signout>Sign out</button>'}</header><main>${content}</main><script src="/assets/app.js" defer></script></body></html>`;
const progress = item => `${item.helpers} of ${item.quorum} people have said it helps`;
// What a person can do or expect next, in plain words, for the feed and the top of an item.
const FEED_STATUS = { SEEN: 'Open for discussion', CHECKED: 'Checked, open for discussion', SPECCED: 'Spec written, not yet sent for a decision', SUBMITTED: 'Waiting for a leader\'s decision', SENDING: 'Approved, being built', SHELVED: 'Shelved' };
const KIND_LABEL = { see: 'SEE', spec: 'SPEC', send: 'SEND', try: 'Try' };
const feedStatus = item => ['TRYING', 'HELPS'].includes(item.state) || item.helpers > 0 ? progress(item) : (FEED_STATUS[item.state] || '');

export function renderEffortAllowance(allowance) {
  const dollars = micros => `$${(micros / 1_000_000).toFixed(4)}`;
  return allowance ? `<section><h2>Effort allowance remaining</h2><p>UTC day ${escape(allowance.day)}. ${allowance.enabled ? 'AI spending enabled.' : 'AI spending disabled or stopped.'}</p><p>You can request ${escape(allowance.mention_requests_person)} more mention replies; this item can accept ${escape(allowance.mention_requests_item)} more. Model calls for mentions and SPEC drafts: ${escape(allowance.on_demand_person)} remaining for you, ${escape(allowance.on_demand_item)} for this item. Automatic first replies: ${escape(allowance.automatic_person)} remaining for you, ${escape(allowance.automatic_item)} for this item.</p><p>Metered budget headroom, including charged holds: ${dollars(allowance.person_micros)} for your Effort calls today, ${dollars(allowance.day_micros)} shared today, ${dollars(allowance.global_micros)} shared overall. Queued work is not reserved yet. Request size, other queued calls, provider availability and money caps can still prevent a reply.</p></section>` : `<p>Effort daily limits: ${EFFORT_LIMITS.calls_per_person_day} mention replies per person, ${EFFORT_LIMITS.calls_per_item_day} per item. Startup replies have a separate limit of ${EFFORT_LIMITS.automatic_calls_per_person_day} per person, ${EFFORT_LIMITS.automatic_calls_per_item_day} per item. Remaining allowances are unavailable in this view. All replies still stop at the shared spend caps.</p>`;
}

export function wordsPage() {
  return shell('What the words mean', `<h1>What the words mean</h1><dl class="words">
<dt>SEE</dt><dd>The problem, in plain words, plus what you already checked.</dd>
<dt>SPEC</dt><dd>What a fix has to do, and how everyone will know it worked.</dd>
<dt>SEND</dt><dd>The request to try a small fix. A leader decides first, then the AI builds a small version for people to try.</dd>
<dt>Effort</dt><dd>The AI that replies first. It's always labeled as AI, and it never decides anything.</dd>
<dt>Steward</dt><dd>Whoever is responsible for the SEE and SPEC right now. Usually the person who posted it.</dd>
<dt>Leader</dt><dd>Someone allowed to approve a try and set its budget. A leader can't approve their own spec.</dd>
<dt>Cap</dt><dd>The most the AI may spend building one try. It stops when it reaches it.</dd>
<dt>Helps</dt><dd>The only way something counts as a win. Enough people who do the work, and who didn't write the spec or approve it, say the try helped.</dd>
<dt>Fork</dt><dd>A new branch from an old SEE, SPEC or try when someone disagrees. A fork starts with no approval.</dd>
<dt>Shelved</dt><dd>Closed on purpose, with a written reason that stays on the record.</dd></dl><p><a href="/">Back</a></p>`, { signedOut: true });
}

export function signInPage({ oidc = false, password = true } = {}) {
  return shell(
    'Sign in',
    `<h1>Sign in</h1><p class="intro">See / Spec / Send is a way for a team to fix the problems everyone already knows about. Someone posts the problem, writes what a fix has to do, and a leader decides. Nothing counts as done until the people who do the work say it helped. <a href="/words">What do these words mean?</a></p>${password ? '<form data-api="/api/login" data-next="/"><label>Your ID<input name="id" required autocomplete="username"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><button>Sign in</button></form>' : ''}${oidc ? '<p><a class="button" href="/api/oidc/start">Sign in with your organization</a></p>' : ''}<p>New here? <a href="/redeem">Redeem an invite</a>.</p>`,
    { signedOut: true },
  );
}

// A temporary password (first leader, or after a reset) can only be used to choose a real one.
export function passwordPage() {
  return shell(
    'Choose a new password',
    `<h1>Choose a new password</h1><p>The password you were given was temporary. Type it once more below, then choose one only you know. You'll be signed in again with it.</p><form data-password="1"><label>The temporary password you were given<input name="current" type="password" required autocomplete="current-password"></label><label>New password (12 or more characters)<input name="password" type="password" required minlength="12" autocomplete="new-password"></label><button>Change password</button></form>`,
  );
}

export function redeemPage() {
  return shell(
    'Redeem invite',
    `<h1>Redeem an invite</h1><p>An invite comes from someone who runs this workspace. Your ID is the name other people will see. Choose a password of at least 12 characters.</p><form data-api="/api/invite/redeem" data-next="/"><label>Invite<input name="invite" required></label><label>Your ID<input name="id" required></label><label>Password (12 or more characters)<input name="password" type="password" required minlength="12" autocomplete="new-password"></label><button>Join</button></form><p>Already have an account? <a href="/signin">Sign in</a>.</p>`,
    { signedOut: true },
  );
}

// A short list of what is waiting on this person, so nobody has to scan the whole feed or wait for a ping that doesn't exist.
function waitingOn(items, person, leader) {
  if (!person) return '';
  const rows = [];
  for (const item of items) {
    if (leader && item.state === 'SUBMITTED' && item.steward !== person) rows.push([item, 'is waiting for your decision']);
    else if (item.state === 'SPECCED' && item.steward === person) rows.push([item, 'has a spec that is ready to send for a decision']);
    else if (item.state === 'TRYING' && item.steward !== person) rows.push([item, 'has a try ready. Use it and say whether it helped']);
  }
  if (!rows.length) return '';
  return `<section class="waiting"><h2>Waiting on you</h2><ul>${rows.slice(0, 8).map(([item, what]) => `<li><a href="/items/${encodeURIComponent(item.id)}">${escape(item.problem)}</a> ${what}.</li>`).join('')}</ul></section>`;
}

export function feedPage(items, next = null, { person = null, leader = false } = {}) {
  const cards =
    items
      .map(
        item =>
          `<li><a href="/items/${encodeURIComponent(item.id)}"><strong>${stages[item.state]}</strong><span>${escape(item.problem)}</span><small>${feedStatus(item)}</small></a></li>`,
      )
      .join('') || '<li>No problems posted yet.</li>';
  return shell(
    'The work',
    '<div class="top"><h1>The work</h1><div><a class="button" href="/quest">Start a Vision Quest (recommended)</a> ' +
      `<a class="button" href="/items/new">Post a problem directly</a></div></div>${waitingOn(items, person, leader)}<p class="intro">A Vision Quest is a short set of guided questions that helps you describe a problem well, with no AI involved. Or post the problem directly if you already know what you want to say.</p><ul class="feed">${cards}</ul>` +
      (next ? `<p><a href="/?after=${encodeURIComponent(next)}">Next page</a></p>` : ''),
  );
}

export function newItemPage() {
  return shell(
    'Post a SEE',
    `<h1>Post a SEE</h1><p>A SEE is the problem as you saw it, in your own words. Say what keeps going wrong and who it affects. If you already checked whether something you have (a setting, a tool you pay for, a free one) solves it, say that too. Plenty of problems end with "oh, it already does that."</p><form data-api="/api/items" data-next-item="true"><label>What happened?<textarea name="original" maxlength="4000" required placeholder="Example: We copy every refund into a spreadsheet by hand. It takes about 20 minutes a day per person. Our CRM has a reports tab, but we haven't looked at whether it covers this."></textarea></label><button>Post SEE</button></form><p><a href="/quest">Start a Vision Quest instead</a></p>`,
  );
}

function eventWords(event) {
  const words = {
    posted: 'posted this SEE',
    revised: 'revised the SEE',
    checked: 'checked what already exists',
    specced: 'wrote the spec',
    approved: 'approved a small try',
    returned: 'returned the spec',
    not_built: `decided ${NOT_BUILT_LABEL}`,
    decided: `recorded ${event.disposition}`,
    experiment_not_helpful: 'closed an experiment as not helpful',
    op_withdrew: 'withdrew the request',
    tried: 'delivered a try',
    helped: 'said the try helps',
    shelved: 'shelved this item',
    steward_changed: 'reassigned the steward',
    commented: 'left a comment',
    checked_in: 'posted a check-in',
    erased: 'erased content',
  };
  // A try is written by a per-item token, so name the person who delivered it instead.
  if (event.type === 'seen') return `${escape(event.source_label)} reported this as ${escape(event.honesty_label)} evidence`;
  return `${escape(event.type === 'tried' && event.delivered_by ? event.delivered_by : event.actor)} ${words[event.type] || 'updated this item'}${['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew'].includes(event.type) && event.reason ? `. Reason: ${escape(event.reason)}` : ''}${event.type === 'erased' ? `${event.ground ? `. Ground: ${escape(event.ground)}. ${escape(event.note)}` : ''}` : ''}${event.type === 'steward_changed' ? ` to ${escape(event.steward)}${event.reason ? `. Note: ${escape(event.reason)}` : ''}` : ''}${event.type === 'tried' && event.model_output ? ' (model output)' : ''}`;
}

// A selected point is an event identity, never an arbitrary artifact blob.
export function forkForm(events, context = {}) {
  const candidates = events.filter(event => ['posted', 'forked', 'revised', 'specced', 'tried'].includes(event.type));
  const totals = { see: 0, spec: 0, artifact: 0 };
  const kindFor = event => event.type === 'specced' ? 'spec' : event.type === 'tried' ? 'artifact' : 'see';
  for (const event of candidates) totals[kindFor(event)] += 1;
  const counts = { see: 0, spec: 0, artifact: 0 };
  const options = candidates.map(event => {
    const kind = kindFor(event); const version = ++counts[kind];
    const historical = version < totals[kind] || (kind === 'artifact' && event.artifact_hash !== context.artifact);
    const label = kind === 'see' ? 'SEE' : kind === 'spec' ? 'Spec' : 'Try';
    return `<option value="${kind}:${escape(event.body_hash)}">${label} ${kind === 'artifact' ? '' : 'v'}${version}${historical ? ' (historical)' : ''}${event.original === '[erased]' || event.text === '[erased]' || event.must?.includes('[erased]') ? ' (erased)' : ''}</option>`;
  }).join('');
  return `<form data-fork="true"><h2>Fork</h2><p>A fork starts as your SEE. Any starting spec is an unapproved draft. It needs its own SEND IT! and independent leader approval before building.</p><label>Start from<select name="from"><option value="">Current point</option>${options}</select></label><label>Why try another direction?<input name="reason" required maxlength="2000"></label><button>Fork</button></form>`;
}

export function scopeFields(scope = {}) {
  return `<fieldset><legend>Proposed scope</legend><p>Use source and audience IDs, one per line. Leaving these empty requests no added sources or audiences. The leader reviews this scope with the spec; writing an ID doesn't connect a source or grant access.</p><label>Data source IDs<textarea name="scope_data_sources">${escape((scope.data_sources || []).join('\n'))}</textarea></label><label>Audience IDs<textarea name="scope_audiences">${escape((scope.audiences || []).join('\n'))}</textarea></label></fieldset>`;
}

// Approving needs fresh proof of who is at the keyboard. A password session re-enters the password; a single-sign-on session
// signs in again at the identity provider, which the page script starts when the person presses the button.
const stepupField = item => (item.ssoStepup
  ? (item.ssoStepupFresh
    ? '<p data-sso-ready="true">You signed in again just now. Press the button to approve.</p>'
    : '<p>Approving asks you to sign in again with your organization account first. You will come back to this page.</p>')
  : '<label>Re-enter your password<input name="password" type="password" required></label>');

export function itemPage(item, events, person, leader) {
  const context = item.context;
  const firstEvent = events[0];
  const rules2 = context.rules >= 2;
  const problem = firstEvent?.original || events.find(event => event.type === 'checked' || event.type === 'seen')?.problem || '';
  const current = events.at(-1);
  const updateSection = (item.annexes || []).length ? `<section id="reanalysis-updates"><h2>Updates since this was frozen</h2>${item.annexes.map(row => `<article><p><strong>Found by Effort (AI)</strong>, ${escape(row.at)}. ${escape(row.body.statement)}</p><p>What is new: ${escape((row.body.what_is_new || []).join(' '))}</p><p>It bears on: ${escape((row.body.bears_on || []).join(' '))}</p><p>Why matched: ${escape(row.body.why_matched)}</p><p>What is not known: ${escape((row.body.not_known || []).join(' '))}</p><form data-annex-response="${escape(row.hash)}"><button name="kind" value="relevant">Relevant</button><button name="kind" value="not_relevant">Not relevant</button><button name="kind" value="mute">Mute my pings</button></form>${(context.steward === person || firstEvent?.actor === person) ? `<form data-renew="${escape(row.hash)}"><label>What is new since the last decision?<input name="what_is_new" required maxlength="2000" value="${escape((row.body.what_is_new || []).join(' '))}"></label><label>Reason<input name="reason" required maxlength="2000"></label><button>Ask for a new decision</button></form>` : ''}</article>`).join('')}</section>` : '';
  const decisionActors = events.filter(event => ['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew'].includes(event.type)).map(event => event.actor);
  const handoffLink = decisionActors.length && events.some(event => event.type === 'specced') ? `<p><a href="/api/items/${encodeURIComponent(item.id)}/handoff?format=md" download>Download handoff (markdown)</a> · <a href="/api/items/${encodeURIComponent(item.id)}/handoff">JSON</a> <small>A change-request package for your ticket system.</small></p>` : '';
  const canReflect = decisionActors.includes(person) || [context.steward, context.originator, ...(context.authors || [])].includes(person);
  const reflection = canReflect && decisionActors.length ? `<section id="private-reflection" data-record="${escape(JSON.stringify(reflectionRecord(item, events, person)))}"></section><script src="/assets/reflection.js" type="module"></script>` : '';
  const questEvent = events.find(event => event.type === 'checked' || (event.type === 'posted' && event.questMemo));
  let questMemo = '';
  let questDraft;
  if (questEvent) {
    questDraft = postedQuestMemo(questEvent);
    if (questDraft && !questDraft.stopped) {
      questMemo = `<section><h2>Vision Quest memo</h2><p>Vision Quest recommendation, not approval to build: <strong>${escape(questDraft.recommendation)}</strong>: ` +
        `${escape(questDraft.reason)}</p><p>Author-reported, not independently verified.</p>` +
        `<p>Decision owner: ${escape(questDraft.memo.decisionOwner)}</p>` +
        `<p>Stop if: ${escape(questDraft.memo.stopCondition)}</p>` +
        `<details><summary>Proposed test, still a draft</summary>` +
        `<p>Must: ${escape(questDraft.spec.must.join('\n'))}</p>` +
        `<p>How we'll know: ${escape(questDraft.spec.how_we_know.join('\n'))}</p>` +
        `<p>Out of scope: ${escape(questDraft.spec.out_of_scope.join('\n'))}</p>` +
        `</details></section>`;
    }
  }
  const spec = events.filter(event => event.type === 'specced').at(-1);
  const specSummary = spec && ['SPECCED', 'SENDING', 'TRYING'].includes(item.state)
    ? `<section class="spec"><h2>Current spec</h2><h3>Must do</h3><ul>${spec.must.map(line => `<li>${escape(line)}</li>`).join('')}</ul><h3>How we'll know</h3><ul>${spec.how_we_know.map(line => `<li>${escape(line)}</li>`).join('')}</ul><h3>Out of scope</h3><ul>${spec.out_of_scope.map(line => `<li>${escape(line)}</li>`).join('')}</ul></section>`
    : '';
  const anchoredComments = events.filter(event => event.type === 'commented').map(event => {
    const currentHash = event.anchor_kind === 'spec' ? context.specHash : context.artifact;
    const stale = event.anchor_hash && event.anchor_hash !== currentHash;
    return `<li>${eventWords(event)}${stale ? ' (stale version)' : event.anchor_hash ? ' (current version)' : ''}: ${escape(event.comment)}</li>`;
  }).join('');
  let action = '';
  // A Vision Quest build proposal is only a first draft: the steward edits it and saves it by hand.
  const draftSpec = firstEvent?.seed_spec || (questDraft && !questDraft.stopped ? questDraft.spec : { must: [], how_we_know: [], out_of_scope: [] });
  const fill = key => escape((draftSpec[key] || []).join('\n'));
  const specForm = `<form data-event="specced" id="write-spec"><h2>Write the spec</h2><p>Say what the fix has to do and how you'll know it worked. Put one item on each line.</p>${rules2 ? `<input type="hidden" name="see_hash" value="${escape(context.seeHash)}">` : ''}` +
    `<label>Must do<textarea name="must" required>${fill('must')}</textarea></label>` +
    `<label>How we'll know<textarea name="how_we_know" required>${fill('how_we_know')}</textarea></label>` +
    `<label>Out of scope<textarea name="out_of_scope">${fill('out_of_scope')}</textarea></label>` +
    `${rules2 ? `<label>Assumptions, one per line<textarea name="assumptions">${fill('assumptions')}</textarea></label><label>Open questions, one per line<textarea name="open_questions">${fill('open_questions')}</textarea></label><details><summary>Advanced: data sources and audiences (leave empty if you're not sure)</summary>${scopeFields(draftSpec.scope)}</details>` : ''}<button>SPEC IT!</button></form>`;
  if ((item.state === 'CHECKED' || (rules2 && item.state === 'SEEN')) && context.steward === person) {
    const draftComment = events.filter(event => event.actor === 'effort' && event.kind === 'agent'
      && event.anchor_hash === context.seeHash && event.comment?.startsWith(SPEC_DRAFT_PREFIX)).at(-1);
    let review = '';
    if (draftComment) {
      try {
        const draft = parseSpecDraft(draftComment.comment.slice(SPEC_DRAFT_PREFIX.length));
        review = `<button type="button" data-spec-draft="${escape(JSON.stringify(draft))}" data-source="${escape(draftComment.body_hash)}">Review AI draft in the spec form</button><p>The draft is a suggestion. Edit it before publishing. Research and costs may still be unknown.</p>`;
      } catch { /* malformed provider output is not an actionable draft */ }
    }
    const request = rules2 ? `<form data-spec-prepare="true"><input type="hidden" name="see_hash" value="${escape(context.seeHash)}"><p>Want a head start? Effort (the AI) can draft a spec from this problem and the discussion so far, and you review it before anything happens. Effort never decides anything. The draft can take a moment: refresh the page to see it.</p><button>Draft SPEC for review</button></form>${review}` : '';
    action = request + specForm;
  }
  if (item.state === 'SUBMITTED') {
    const packetBody = item.packet ? `<pre>${escape(item.packet)}</pre>` : '';
    action = `<section id="decision"><h2>Decision packet</h2><p>Research: no source connected, nothing checked.</p>${packetBody}</section>` +
      (leader && context.steward !== person && !context.authors?.includes(person) ? `<form data-approve="true"><h2>Approve bounded work</h2><input type="hidden" name="spec_hash" value="${escape(context.specHash)}"><input type="hidden" name="packet_hash" value="${escape(context.sent.packetHash)}"><label>Reason for your decision<textarea name="reason" required minlength="12"></textarea></label><p>You are setting the limits for a small trial. The builder can't go past them, and nothing counts as a win until enough people who do the work say it helps.</p><label>Cap in dollars<small>The most the AI may spend building this. It stops when it reaches it. Most tries need a few dollars. The highest allowed is $10,000.</small><input name="cap_usd" type="number" min="0" max="10000" step="0.01" required></label><label>How many people need to say it helps?<small>They must be people other than the one who wrote the spec and you.</small><input name="quorum" type="number" min="1" required></label><label>Maximum additional build turns (1 to 5)<small>How many times the builder may revise its work after the first try.</small><input name="max_iterations" type="number" min="1" max="5" value="5" required></label><label>Time window in minutes<small>How long this approval stays open. The default is one week.</small><input name="window_minutes" type="number" min="1" step="1" value="10080" required></label>${stepupField(item)}<button>Approve the try</button></form><form data-decision="true"><h2>Record another decision</h2><input type="hidden" name="spec_hash" value="${escape(context.specHash)}"><input type="hidden" name="packet_hash" value="${escape(context.sent.packetHash)}"><label>Outcome<select name="disposition"><option value="return_for_revision">Return for revision</option><option value="defer">Defer</option><option value="redirect">Redirect</option><option value="resolve_without_build">Resolve without build</option><option value="decline">Decline</option><option value="prohibited">Prohibited</option></select></label><label>A short label for this decision<small>A few words you'd search for later, like "wrong-time" or "already-covered".</small><input name="reason_code" required maxlength="120"></label><label>Reason<textarea name="reason" required minlength="12" maxlength="2000"></textarea></label><details><summary>More detail about this decision (all optional)</summary><fieldset><legend>Outcome details</legend><label>Decision changing information needed<input name="needed" maxlength="2000"></label><label>Next reviewer<input name="next_reviewer" maxlength="2000"></label><label>Accountable owner<input name="owner" maxlength="2000"></label><label>Review date<input name="review_by" type="date"></label><label>Reconsideration trigger<input name="trigger" maxlength="2000"></label><label>Permitted interim work<input name="interim_work" maxlength="2000"></label><label>Destination role or team<input name="destination" maxlength="2000"></label><label>Destination accepted<select name="accepted"><option value="">Not recorded</option><option value="true">Yes</option><option value="false">No</option></select></label><label>Follow-up owner<input name="follow_up_owner" maxlength="2000"></label><label>Non-build alternative<input name="alternative" maxlength="2000"></label><label>Action owner<input name="action_owner" maxlength="2000"></label><label>Reconsider if<input name="reconsider_if" maxlength="2000"></label><label>Policy reference<input name="policy_class" maxlength="2000"></label></fieldset></details><button>Record decision</button></form>` : '');
    if (context.rules !== 3) {
      action = action.replace(/<form data-decision="true">[\s\S]*?<\/form>/, '');
      if (leader && context.steward !== person && !context.authors?.includes(person)) action +=
        `<form data-event="returned"><input type="hidden" name="spec_hash" value="${escape(context.specHash)}"><input type="hidden" name="packet_hash" value="${escape(context.sent.packetHash)}"><label>Reason to return<textarea name="reason" required minlength="12"></textarea></label><button>Return the spec</button></form><form data-event="not_built"><input type="hidden" name="spec_hash" value="${escape(context.specHash)}"><input type="hidden" name="packet_hash" value="${escape(context.sent.packetHash)}"><label>Reason not to build<textarea name="reason" required minlength="12"></textarea></label><label>Restricted evidence (optional)<input name="restricted_evidence"></label><label>What changed later (optional)<input name="pivot_note"></label><button>${escape(NOT_BUILT_LABEL)}</button></form>`;
    }
  }
  if (context.rules === 3 && context.activePost?.kind === 'send') {
    action += `<section><h2>SEND review thread</h2><p>Comments here do not change the frozen decision packet.</p><form data-event="commented"><label>Comment on this submission<textarea name="comment" required maxlength="4000"></textarea></label><input type="hidden" name="kind" value="comment"><input type="hidden" name="anchor_kind" value="send"><input type="hidden" name="anchor_hash" value="${escape(context.activePost.version)}"><button>Post comment</button></form>${renderThread(events, { ...context, steward: null }, 'send')}</section>`;
  }
  if (item.state === 'SPECCED' && !rules2 && leader && context.steward !== person)
    action = `<form data-approve="true"><h2>Decide</h2><p>Approval freezes the cap. The configured provider and its worst-case micro-dollar estimate are shown by the gateway administrator before this screen is used.</p><input type="hidden" name="spec_hash" value="${escape(context.specHash)}"><input type="hidden" name="expected_seq" value="${events.length}"><label>Cap in dollars<input name="cap_usd" type="number" min="0" step="0.01" required></label><label>How many people need to say it helps?<input name="quorum" type="number" min="1" required></label>${stepupField(item)}<button>Approve the try</button></form><form data-event="returned"><label>What needs to change?<input name="note" required></label><button>Return the spec</button></form>`;
  if (item.state === 'SENDING' && (leader || context.steward === person))
    action = `<form data-artifact="true"><h2>Deliver the try</h2><label>One HTML document<textarea name="html" required></textarea></label><button>Deliver the try</button></form>`;
  if (item.state === 'TRYING') {
    const canVote = !context.ineligibleHelpers.includes(person);
    // A model-built try gets no script permission in its frame. A hand-delivered try keeps its frame.
    const modelTry = events.some(event => event.type === 'tried' && event.artifact_hash === context.artifact && event.model_output === true);
    const frameSandbox = modelTry ? 'sandbox=""' : 'sandbox="allow-scripts"';
    // allow-same-origin is safe here only because bundleFrameUrl is a different origin from the app.
    const frame = item.bundleFrameUrl && modelTry
      ? `<iframe title="Playable try" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" src="${escape(item.bundleFrameUrl)}"></iframe>`
      : `<iframe title="Playable try" ${frameSandbox} src="/api/items/${encodeURIComponent(item.id)}/artifact/${encodeURIComponent(context.artifact)}"></iframe>`;
    const alreadySaid = context.helpers.includes(person);
    action = `<section id="try"><h2>The try</h2>${frame}${alreadySaid ? '<p class="helps">You said this helps. It counts once.</p>' : canVote ? `<form data-event="helped"><input type="hidden" name="artifact_hash" value="${escape(context.artifact)}"><p><small>Press this only if it really helped you do the job. If it didn't, say so in the comments.</small></p><button>It helps</button></form>` : '<p>You helped shape this one, so others say whether it helps.</p>'}${context.steward === person ? '<form data-steer="true"><h2>Adopt as builder instruction</h2><label>Instruction<textarea name="instruction" required></textarea></label><button>Adopt as builder instruction</button></form>' : ''}</section>`;
  }
  if (item.state === 'HELPS')
    action = '<p class="helps">People who do this work said it helps.</p>';
  if (item.state === 'SHELVED')
    action = `<p>This was shelved: ${escape(current?.reason || '')}</p>`;
  if (item.state === 'CHECKED' && questDraft && questDraft.recommendation !== 'BUILD') {
    action = '<p>No build is proposed. Ask the decision owner to review the existing option.</p>';
  }
  // After approval the frozen packet stays readable to everyone, next to the written reason.
  const packetView = item.packet && ['SPECCED', 'SENDING', 'TRYING', 'HELPS'].includes(item.state)
    ? `<section><details><summary>The exact record that was reviewed, for auditors</summary><pre>${escape(item.packet)}</pre></details></section>` : '';
  const shelve =
    !['HELPS', 'SHELVED'].includes(item.state) && (leader || context.steward === person)
      ? `<form data-event="shelved"><label>Why shelve it?<input name="reason" required></label><button>Shelve with a reason</button></form>`
      : '';
  const anchor = rules2 ? { kind: 'see', hash: context.seeHash } : context.artifact ? { kind: 'artifact', hash: context.artifact } :
    context.specHash ? { kind: 'spec', hash: context.specHash } : null;
  const comment = rules2
    ? `<form data-event="commented"><h2>Join the thread</h2><label>Comment<textarea name="comment" required maxlength="4000"></textarea></label><label>Type<select name="kind"><option value="comment">Comment</option><option value="question">Question</option><option value="concern">Concern</option><option value="alternative">Alternative (a different approach)</option></select></label><input type="hidden" name="anchor_kind" value="see"><input type="hidden" name="anchor_hash" value="${escape(context.seeHash)}"><button>Post comment</button></form>`
    : `<form data-event="commented"><h2>Comment</h2><label>Comment<textarea name="comment" required maxlength="4000"></textarea></label>${anchor ? `<input type="hidden" name="anchor_kind" value="${anchor.kind}"><input type="hidden" name="anchor_hash" value="${escape(anchor.hash)}"><p>Attached to the current ${anchor.kind} version.</p>` : '<p>There is no spec version yet.</p>'}<button>Post comment</button></form>`;
  const tryThread = rules2 && item.state === 'TRYING' && context.artifact
    ? `<h2>Try thread</h2><form data-event="commented" class="didnt-help"><label>It didn't help. What was missing or wrong?<small>This isn't a vote. It goes in the thread for the team and the leader, who can close the try as not helpful.</small><textarea name="comment" required maxlength="4000"></textarea></label><input type="hidden" name="kind" value="concern"><input type="hidden" name="anchor_kind" value="artifact"><input type="hidden" name="anchor_hash" value="${escape(context.artifact)}"><button>It didn't help</button></form><form data-event="commented"><label>Comment on this try<textarea name="comment" required maxlength="4000"></textarea></label><input type="hidden" name="kind" value="comment"><input type="hidden" name="anchor_kind" value="artifact"><input type="hidden" name="anchor_hash" value="${escape(context.artifact)}"><button>Post comment</button></form>${renderThread(events, { ...context, steward: context.steward === person ? context.steward : null }, 'artifact') || '<p>No try comments yet.</p>'}` : '';
  // Feedback on a superseded try stays readable as history (read-only: no reply, adopt or include controls).
  const oldTryFeedback = rules2 && context.superseded && item.state !== 'TRYING'
    ? events.filter(event => event.type === 'commented' && event.anchor_kind === 'artifact')
      .map(event => `<li id="comment-${escape(event.body_hash)}"><p><strong>${escape(event.actor)}</strong>${event.kind === 'agent' ? ' (Effort, AI)' : ` (${escape(event.kind)})`}: ${escape(event.comment)}</p></li>`).join('') : '';
  const oldTryHistory = oldTryFeedback ? `<section><h2>Feedback on the superseded try</h2><ol>${oldTryFeedback}</ol></section>` : '';
  let priorSee = firstEvent?.original || '';
  const creditHistory = credits => (credits || []).map(credit => {
    const source = events.find(entry => entry.type === 'commented' && entry.body_hash === credit.comment);
    if (!source || source.comment === '[erased]') return 'credit source erased';
    return `credit: ${escape(source.actor)}, ${escape(credit.mode)} (<a href="#comment-${escape(credit.comment)}">source comment</a>)`;
  }).join('; ');
  const revisions = rules2 ? events.filter(event => event.type === 'revised').map((event, index) => {
    const diff = lineDiff(priorSee, event.text); priorSee = event.text;
    return `<li>SEE v${index + 2}: ${escape(event.text)}${event.credits?.length ? ` (${creditHistory(event.credits)})` : ''}<details><summary>What changed</summary>${diff.map(row => `<p>${escape(row.kind)}: ${escape(row.line)}</p>`).join('')}</details></li>`;
  }).join('') : '';
  const revise = rules2 && context.steward === person ? `<form data-event="revised"><h2>Revise SEE</h2><input type="hidden" name="base_hash" value="${escape(context.seeHash)}"><label>Current SEE<textarea name="text" required maxlength="4000">${escape(events.filter(event => event.type === 'revised').at(-1)?.text || firstEvent.original)}</textarea></label><button>Save revision</button></form>` : '';
  const specLink = rules2 && context.specHash ? `<p><a class="button" href="/items/${encodeURIComponent(item.id)}/spec">Open the spec</a></p>` : '';
  const see = rules2 ? `<details><summary>Original post, versions and record</summary><section><h2>Original</h2><p>${escape(firstEvent.original)}</p><p>Hash ${escape(firstEvent.body_hash)}, posted ${escape(firstEvent.at)}</p><h2>Current SEE v${escape(context.seeVersion)}</h2><p>${escape(events.filter(event => event.type === 'revised').at(-1)?.text || firstEvent.original)}</p><h2>Version history</h2><ol><li>SEE v1: ${escape(firstEvent.original)}</li>${revisions}</ol></section></details>${specLink}` : '';
  const forkedFrom = context.parent ? `<p>Forked from <a href="/items/${encodeURIComponent(context.parent.item)}">the original item</a>${firstEvent?.from ? `, selected ${escape(firstEvent.from.kind)} event ${escape(firstEvent.from.hash)}` : ''}, at event ${escape(context.parent.seq)}${firstEvent?.reason ? `: ${escape(firstEvent.reason)}` : ''}.</p>` : '';
  const fork = rules2 ? forkForm(events, context) : '';
  const forkDraft = firstEvent?.seed_spec ? `<section><h2>Fork starting spec (unapproved draft)</h2><p>This is starting material from the selected parent point. It isn't a saved spec or approval to build.</p><h3>Must do</h3><ul>${firstEvent.seed_spec.must.map(value => `<li>${escape(value)}</li>`).join('')}</ul><h3>How we'll know</h3><ul>${firstEvent.seed_spec.how_we_know.map(value => `<li>${escape(value)}</li>`).join('')}</ul></section>` : '';
  const reassign = rules2 && leader && !['HELPS', 'SHELVED'].includes(item.state)
    ? `<form data-event="steward_changed"><h2>Reassign steward</h2><p>Only after the current steward records consent, or has made no event anywhere for 14 days.</p><label>New steward (person ID)<input name="steward" required maxlength="64"></label><label>Note, at least 12 characters<input name="reason" required minlength="12" maxlength="2000"></label><button>Reassign steward</button></form>` : '';
  const checkin = `<form data-event="checked_in"><h2>Check-in</h2><label>What changed?<input name="note" required maxlength="2000"></label>${rules2 && context.steward === person ? '<label><input type="checkbox" name="consent" value="true"> I consent to a leader assigning a new steward.</label>' : ''}<button>Post check-in</button></form>`;
  const outcomeActions = context.rules === 3 && context.activePost ? `${context.steward === person ? '<form data-event="op_withdrew"><h2>Withdraw this request</h2><label>Reason<input name="reason" required maxlength="2000"></label><button>Withdraw and stop active work</button></form>' : ''}${item.state === 'TRYING' && leader && !context.authors?.includes(person) ? `<form data-event="experiment_not_helpful"><h2>Close experiment: did not help</h2><p>This is a leader-reported test outcome. It isn't an independent HELPS vote.</p><input type="hidden" name="approval" value="${escape(context.approval)}"><input type="hidden" name="spec_hash" value="${escape(context.specHash)}"><input type="hidden" name="artifact_hash" value="${escape(context.artifact)}"><label>Reason<input name="reason" required minlength="12" maxlength="2000"></label><label>Observed evidence<textarea name="evidence_summary" required maxlength="2000"></textarea></label><label>Evidence limits<textarea name="evidence_limits" required maxlength="2000"></textarea></label><button>Record experiment outcome</button></form>` : ''}` : '';
  const effortStatus = renderEffortStatus(item.effort);
  const effortAllowance = renderEffortAllowance(item.effortAllowance);
  const instructions = events.filter(event => event.type === 'steered' && event.approval === context.approval)
    .map(event => `<li>${escape(event.instruction)}${event.source ? ` (from ${escape(event.source)})` : ''}</li>`).join('');
  const currentDecisionPacket = context.decided?.packetHash ? item.decisionPackets?.[context.decided.packetHash] : null;
  const decision = context.decided ? `<section><h2>Decision record</h2><p><strong>${escape(decisionLabels[context.decided.disposition] || context.decided.disposition)}</strong>, by ${escape(context.decided.actor)} on ${escape(context.decided.at)}.</p><p>${escape(context.decided.reason)}</p>${context.decided.reasonCode ? `<p>Reason code: ${escape(context.decided.reasonCode)}</p>` : ''}${context.decided.metadata && Object.keys(context.decided.metadata).length ? `<h3>Recorded details</h3><pre>${escape(JSON.stringify(context.decided.metadata, null, 2))}</pre>` : ''}${context.decided.evidenceSummary ? `<p>Leader-reported test-ending decision. This isn't an independent HELPS result.</p><p>Observed evidence: ${escape(context.decided.evidenceSummary)}</p><p>Evidence limits: ${escape(context.decided.evidenceLimits)}</p>` : ''}${context.decided.restrictedEvidence ? `<p>${escape(context.decided.restrictedEvidence)}</p>` : ''}${context.decided.pivotNote ? `<p>What changed: ${escape(context.decided.pivotNote)}</p>` : ''}${context.decided.packetHash ? `<p>Reviewed packet: ${escape(context.decided.packetHash)}. Reviewed spec: ${escape(context.decided.specHash)}.</p>` : ''}${context.rules === 3 && context.decided.packetHash ? (currentDecisionPacket ? `<details><summary>Reviewed evidence snapshot</summary><pre>${escape(currentDecisionPacket)}</pre></details>` : '<p>Reviewed evidence snapshot is unavailable.</p>') : ''}</section>` : '';
  const leash = context.leash ? `<section><h2>Limits of this approval</h2><p>Up to ${escape(context.leash.maxIterations)} additional build turns, ${escape(context.leash.windowMinutes)} minutes${context.leash.expiresAt ? `, until ${escape(context.leash.expiresAt)}` : ''}. Cap: $${escape((context.capMicros / 1_000_000).toFixed(2))}. ${escape(context.quorum)} independent people must say it helps.</p></section>` : '';
  const decisionHistory = events.filter(event => ['approved', 'returned', 'not_built', 'decided', 'experiment_not_helpful', 'op_withdrew'].includes(event.type)
    && !(context.rules === 3 && event.body_hash === context.decided?.bodyHash)).map(event => {
    const packet = item.decisionPackets?.[event.packet_hash];
    return `<li><h3>${escape(event.type === 'decided' ? decisionLabels[event.disposition] : event.type === 'experiment_not_helpful' ? decisionLabels.experiment_did_not_help : decisionLabels[event.type] || event.type)}</h3><p>By ${escape(event.actor)} on ${escape(event.at)}. Reason: ${escape(event.reason)}</p>` +
      `${event.reason_code ? `<p>Reason code: ${escape(event.reason_code)}</p>` : ''}${event.metadata ? `<pre>${escape(JSON.stringify(event.metadata, null, 2))}</pre>` : ''}${event.evidence_summary ? `<p>Observed evidence: ${escape(event.evidence_summary)}</p><p>Evidence limits: ${escape(event.evidence_limits || 'Not recorded')}</p>` : ''}` +
      `${event.restricted_evidence ? `<p>${escape(event.restricted_evidence)}</p>` : ''}${event.pivot_note ? `<p>What changed: ${escape(event.pivot_note)}</p>` : ''}` +
      `${event.packet_hash ? `<p>Reviewed packet: ${escape(event.packet_hash)}. Reviewed spec: ${escape(event.spec_hash)}.</p>` : ''}` +
      `${event.type === 'approved' ? `<p>Approved limits: $${escape(event.cap_usd)}, ${escape(event.quorum)} independent helpers, up to ${escape(event.max_iterations ?? 5)} additional build turns, ${escape(event.window_minutes ?? 10080)} minutes${event.expires_at ? `, until ${escape(event.expires_at)}` : ''}.</p>` : ''}` +
      `${packet ? `<details><summary>Reviewed evidence snapshot</summary><pre>${escape(packet)}</pre></details>` : '<p>Reviewed evidence snapshot is unavailable.</p>'}</li>`;
  }).join('');
  const stageHistory = context.rules === 3 ? `<section><h2>Stage history</h2><ul>${(item.stagePosts || []).map(post => `<li>${post.closed_seq === null ? escape(KIND_LABEL[post.kind] || post.kind) : `<a href="/items/${encodeURIComponent(item.id)}/history/${encodeURIComponent(post.post_id)}">${escape(KIND_LABEL[post.kind] || post.kind)}</a>`}: ${post.closed_seq === null ? 'in progress' : `locked at step ${escape(post.closed_seq)}; a closing report is being prepared`}</li>`).join('')}</ul></section>` : '<p>Legacy record: historical stage freezes were not recorded.</p>';
  const erasures = events.filter(event => event.type === 'erased').map(event => `<li>Content erased by ${escape(event.actor)} on ${escape(event.at)}. ${event.ground ? `Ground: ${escape(event.ground)}. ${escape(event.note)}` : 'No privacy ground was recorded.'} Erasure record: ${escape(event.body_hash)}.</li>`).join('');
  const commentBlock = context.rules !== 3 || context.activePost?.kind === 'see' ? comment : '';
  const threadBlock = `<h2>${rules2 ? 'Thread' : 'Comments'}</h2>${rules2 ? (events.some(event => event.type === 'commented') ? (renderThread(events, { ...context, readOnly: context.rules === 3 && context.activePost?.kind !== 'see', steward: context.steward === person ? context.steward : null }) || '<p>No comments yet.</p>') : '<p>No comments yet. Add what you know, or ask a question.</p>') : `<ol>${anchoredComments || '<li>No comments yet.</li>'}</ol>`}`;
  const specHref = `/items/${encodeURIComponent(item.id)}/spec`;
  const isSteward = context.steward === person;
  // One plain sentence about what to do next, for whoever is looking at this item.
  const nextStep = (() => {
    const state = item.state;
    if (state === 'SEEN' || state === 'CHECKED') return isSteward
      ? '<p><strong>Next:</strong> let people talk it over in the thread below. When the problem is clear, <a href="#write-spec">write the spec</a>: what a fix has to do, and how you\'ll know it worked.</p>'
      : '<p><strong>Next:</strong> add what you know in the thread below. To ask Effort (the AI) a question, write @effort in your comment.</p>';
    // A leader has already answered this spec. Say what that answer means, not "press SEND IT!".
    const answered = state === 'SPECCED' && context.decided && context.decided.specHash === context.specHash ? context.decided.disposition : null;
    if (answered) {
      const outcome = {
        return_for_revision: isSteward
          ? 'A leader sent this back for changes. Read their reason below, update the spec, then press SEND IT! again.'
          : 'A leader sent this back for changes. The steward will update the spec and send it again.',
        defer: 'A leader put this on hold. Their reason, and who looks at it next, are below.',
        redirect: 'A leader sent this to another team or person. The details are below.',
        resolve_without_build: 'A leader decided this is solved without building anything new. The reason is below.',
        decline: 'A leader decided not to build this. The reason is below. If you see it differently, fork it to try another direction.',
        prohibited: 'This can\'t be done. The reason is below.',
      }[answered] || 'A leader recorded a decision. The reason is below.';
      return `<p><strong>Decided.</strong> ${outcome}</p>`;
    }
    if (state === 'SPECCED') return isSteward
      ? `<p><strong>Your spec is written. Next:</strong> <a href="${specHref}">open it</a> and press SEND IT! so a leader can decide whether to try it.</p>`
      : `<p><strong>A spec has been written.</strong> <a href="${specHref}">Read it</a> and say what you think in the thread. The steward will send it to a leader.</p>`;
    if (state === 'SUBMITTED') return leader && !isSteward
      ? '<p><strong>This is waiting for a leader\'s decision.</strong> You can approve it with a budget, send it back with a reason, or record that it won\'t be built.</p>'
      : '<p><strong>Waiting for a leader\'s decision.</strong> A leader who didn\'t write the spec will approve it, send it back, or record that it won\'t be built.</p>';
    if (state === 'SENDING') return '<p><strong>Approved.</strong> A small version is being built. It will show up here when it\'s ready to try.</p>';
    if (state === 'TRYING') return '<p><strong>A try is ready.</strong> <a href="#try">Jump to it</a>, use it, then say whether it helped. It only counts as a win when enough people who do the work say it helps. If it doesn\'t help, use the "It didn\'t help" box under the try and say what was missing. Don\'t press the button.</p>';
    if (state === 'HELPS') return '<p><strong>People who do the work said it helps.</strong> The record of how it got here is below.</p>';
    if (state === 'SHELVED') return '<p><strong>This was shelved.</strong> The reason is on the record below.</p>';
    return '';
  })();
  const nextStepHtml = nextStep ? `<div class="next">${nextStep}</div>` : '';
  return shell(
    problem,
    handoffLink + updateSection + (context.rules === 3 && context.activePost ? `<span hidden data-active-post="${escape(context.activePost.id)}" data-post-version="${escape(context.activePost.version)}"></span>` : '') + '<p><a href="/">Back to the work</a></p>' +
      `<p class="stage">${context.rules === 3 && !context.activePost && context.phase === 'SPECCED' ? 'Branch frozen' : stages[item.state]}</p><h1>${escape(problem)}</h1><p>Originator: <a href="/people/${encodeURIComponent(context.originator || context.steward)}">${escape(context.originator || context.steward)}</a>. Current steward: <a href="/people/${encodeURIComponent(context.steward)}">${escape(context.steward)}</a>.</p><p><a href="/items/${encodeURIComponent(item.id)}/related">Discover related work</a></p>` +
      `${['TRYING', 'HELPS'].includes(item.state) || context.helpers.length > 0 ? `<p>${progress({ helpers: context.helpers.length, quorum: context.quorum })}</p>` : ''}${reflection}${context.superseded ? `<p>This old approval is superseded. Update the spec, SEND IT!, and get a new leader approval.${context.supersededArtifact ? ' The delivered try is superseded and cannot receive new Helps votes.' : ''}</p>` : ''}${forkedFrom}${nextStepHtml}${commentBlock}${threadBlock}${stageHistory}${effortStatus}<p><small><a href="/words">What do these words mean?</a></small></p><details><summary>AI usage and limits for this item</summary>${effortAllowance}</details>${see}${forkDraft}${questMemo}${specSummary}${decision}${leash}${decisionHistory ? `<section><h2>Decision history</h2><ol>${decisionHistory}</ol></section>` : ''}${erasures ? `<section><h2>Erased content</h2><ol>${erasures}</ol></section>` : ''}${context.rules !== 3 || context.activePost?.kind === 'see' ? revise : '<p>SEE discussion is frozen. Fork it to continue a separate discussion.</p>'}${action}${packetView}${tryThread}${oldTryHistory}${instructions ? `<section><h2>Builder instructions</h2><ol>${instructions}</ol></section>` : ''}${fork}${context.rules === 3 && (item.stagePosts || []).some(post => post.closed_seq !== null) ? `<form data-fork-frozen="true"><h2>Fork a frozen stage</h2><label>Frozen snapshot<select name="from">${(item.stagePosts || []).filter(post => post.closed_seq !== null).map(post => `<option value="snapshot|${escape(post.post_id)}|${escape(post.snapshot_hash)}">${escape(post.kind)} at event ${escape(post.closed_seq)}</option>`).join('')}</select></label><label>Reason<input name="reason" required maxlength="2000"></label><button>Fork frozen stage</button></form>` : ''}${context.rules !== 3 || context.activePost ? shelve : ''}${context.rules !== 3 || context.activePost ? reassign + checkin : ''}${outcomeActions}` +
      `<h2>What happened</h2><ol>${events.filter(event => event.type !== 'commented' && event.type !== 'revised').map(event => `<li>${eventWords(event)}</li>`).join('')}</ol>`,
  );
}

export const htmlHeaders =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";


export function questPage(person) {
  return shell('Vision Quest', `
    <p><a href="/">Back to the work</a></p>
    <h1>Vision Quest</h1>
    <p>Start with the last real occurrence. One question at a time, no AI calls.</p>
    <p>This guide can use only what you type. Your account isn't independent verification.
      Only your derived memo is saved to the shared item. Posting sends your answers to this server
      temporarily so it can check the memo again. Nothing is posted until you choose to post.</p>
    <section id="quest" data-person="${escape(person)}">
      <p id="quest-status" role="status">Opening your draft...</p>
      <div id="quest-content"></div>
      <p id="quest-error" class="error" role="alert"></p>
      <div class="quest-tools">
        <button type="button" id="quest-compact">Compact</button>
        <button type="button" id="quest-squirrel">Squirrel?</button>
        <button type="button" id="quest-export">Export draft</button>
        <button type="button" id="quest-portable-export">Export portable prompt</button>
        <label>Paste portable memo JSON<textarea id="quest-portable-memo" maxlength="120000"></textarea></label>
        <button type="button" id="quest-portable-import">Check pasted memo</button>
        <button type="button" id="quest-new">Start another quest</button>
        <div id="quest-history"></div>
        <label>Restore your own draft file<input type="file" id="quest-restore"
          accept="application/json,.json"></label>
      </div>
      <pre id="quest-note"></pre>
      <p>Drafts stay in this browser for this signed-in ID. Export before clearing browser data.
        A SHA check detects changed bytes; it doesn't prove that an account is true.</p>
    </section>
    <script type="module" src="/assets/quest-ui.js"></script>
  `);
}

export function frozenPostPage(item, post, events, closeout, sourceHashes = [], annexes = []) {
  const relevant = events.slice(post.opened_seq - 1, post.closed_seq);
  const opening = relevant[0];
  const baseSpec = post.kind === 'spec' && opening?.type === 'returned' ? events.find(event => event.type === 'specced' && event.body_hash === opening.spec_hash) : null;
  const inherited = baseSpec ? `<h2>Starting SPEC from the reviewed version</h2><pre>${escape(JSON.stringify({ must: baseSpec.must, how_we_know: baseSpec.how_we_know, out_of_scope: baseSpec.out_of_scope, assumptions: baseSpec.assumptions, open_questions: baseSpec.open_questions }, null, 2))}</pre>` : '';
  const lines = relevant.map(event => `<li><strong>${escape(event.type)}</strong> by ${escape(event.actor)} on ${escape(event.at)}<pre>${escape(JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => !['type', 'actor', 'at'].includes(key))), null, 2))}</pre>${event.type === 'commented' && sourceHashes.includes(event.body_hash) ? `<p><a href="/items/${encodeURIComponent(item)}/spec?source_comment=${encodeURIComponent(event.body_hash)}">Use as source in current SPEC</a></p>` : ''}</li>`).join('');
  const report = closeout?.state === 'done' ? `<p><a href="/items/${encodeURIComponent(item)}/closeout/${encodeURIComponent(post.post_id)}">Read closing report</a> · <a href="/api/items/${encodeURIComponent(item)}/closeout/${encodeURIComponent(post.post_id)}">JSON</a></p>` : '';
  const updates = annexes.map(row => `<article><p><strong>Found by Effort (AI)</strong>, ${escape(row.at)}. ${escape(row.body.statement)}</p><p>What is new: ${escape((row.body.what_is_new || []).join(' '))}</p><p>It bears on: ${escape((row.body.bears_on || []).join(' '))}</p><p>Why matched: ${escape(row.body.why_matched)}</p><p>What is not known: ${escape((row.body.not_known || []).join(' '))}</p><form data-annex-response="${escape(row.hash)}"><button name="kind" value="relevant">Relevant</button><button name="kind" value="not_relevant">Not relevant</button><button name="kind" value="mute">Mute my pings</button></form></article>`).join('');
  return shell('Frozen stage', `<p><a href="/items/${encodeURIComponent(item)}">Back to the branch</a></p><h1>Frozen ${escape(post.kind)} post</h1><p>Snapshot ${escape(post.snapshot_hash)}, event ${escape(post.closed_seq)}. Closing report ${escape(closeout?.state || 'unavailable')}.</p>${report}${inherited}<ol>${lines}</ol>${updates ? `<section id="reanalysis-updates"><h2>Updates since this was frozen</h2>${updates}</section>` : ''}<form data-fork-frozen="true"><input type="hidden" name="from" value="snapshot|${escape(post.post_id)}|${escape(post.snapshot_hash)}"><label>Reason<input name="reason" required maxlength="2000"></label><button>Fork frozen stage</button></form>`);
}

export function closeoutPage(item, post, report) {
  const blocks = ['facts', 'reported_claims', 'assumptions', 'open_questions', 'discussion', 'decisions'].map(name =>
    `<section><h2>${escape(name.replaceAll('_', ' '))}</h2><pre>${escape(JSON.stringify(report[name] || [], null, 2))}</pre></section>`).join('');
  return shell('Closing report', `<p><a href="/items/${encodeURIComponent(item)}/history/${encodeURIComponent(post)}">Back to frozen post</a></p><h1>Closing report</h1><p>This readable view is generated from the frozen record. It isn't a new decision or an AI sign-off.</p>${blocks}<section><h2>This is wrong / Add context</h2>${report._source_hash ? `<form data-correction="${escape(report._source_hash)}"><label>Attributed note<textarea name="note" required maxlength="2000"></textarea></label><button>This is wrong / Add context</button></form>` : '<p>No source record is available for a correction.</p>'}</section><script src="/assets/app.js" defer></script>`);
}
