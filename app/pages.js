import { postedQuestMemo } from '../public/vision-quest.js';
import { renderThread } from './pages-thread.js';
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
const shell = (title, content) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/assets/app.css"></head><body><header><a href="/">See / Spec / Send</a></header><main>${content}</main><script src="/assets/app.js" defer></script></body></html>`;
const progress = item => `${item.helpers} of ${item.quorum} people have said it helps`;

export function signInPage({ oidc = false } = {}) {
  return shell(
    'Sign in',
    `<h1>Sign in</h1><form data-api="/api/login" data-next="/"><label>Your ID<input name="id" required autocomplete="username"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><button>Sign in</button></form>${oidc ? '<p><a class="button" href="/api/oidc/start">Sign in with your organization</a></p>' : ''}<p><a href="/redeem">Redeem an invite</a></p>`,
  );
}

export function redeemPage() {
  return shell(
    'Redeem invite',
    `<h1>Redeem an invite</h1><form data-api="/api/invite/redeem" data-next="/"><label>Invite<input name="invite" required></label><label>Your ID<input name="id" required></label><label>Password<input name="password" type="password" required autocomplete="new-password"></label><button>Join</button></form>`,
  );
}

export function feedPage(items, next = null) {
  const cards =
    items
      .map(
        item =>
          `<li><a href="/items/${encodeURIComponent(item.id)}"><strong>${stages[item.state]}</strong><span>${escape(item.problem)}</span><small>${progress(item)}</small></a></li>`,
      )
      .join('') || '<li>No problems posted yet.</li>';
  return shell(
    'The work',
    '<div class="top"><h1>The work</h1><div><a class="button" href="/items/new">Post a problem</a> ' +
      `<a href="/quest">Start a Vision Quest</a></div></div><ul class="feed">${cards}</ul>` +
      (next ? `<p><a href="/?after=${encodeURIComponent(next)}">Next page</a></p>` : ''),
  );
}

export function newItemPage() {
  return shell(
    'Post a SEE',
    `<h1>Post a SEE</h1><p>Share what you saw, in your own words.</p><form data-api="/api/items" data-next-item="true"><label>What happened?<textarea name="original" maxlength="4000" required></textarea></label><button>Post SEE</button></form><p><a href="/quest">Start a Vision Quest instead</a></p>`,
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
    tried: 'delivered a try',
    helped: 'said the try helps',
    shelved: 'shelved this item',
    steward_changed: 'changed the steward',
    commented: 'left a comment',
    checked_in: 'posted a check-in',
  };
  // A try is written by a per-item token, so name the person who delivered it instead.
  if (event.type === 'seen') return `${escape(event.source_label)} reported this as ${escape(event.honesty_label)} evidence`;
  return `${escape(event.type === 'tried' && event.delivered_by ? event.delivered_by : event.actor)} ${words[event.type] || 'updated this item'}${event.type === 'tried' && event.model_output ? ' (model output)' : ''}`;
}

export function itemPage(item, events, person, leader) {
  const context = item.context;
  const firstEvent = events[0];
  const rules2 = context.rules >= 2;
  const problem = firstEvent?.original || events.find(event => event.type === 'checked' || event.type === 'seen')?.problem || '';
  const current = events.at(-1);
  const questEvent = events.find(event => event.type === 'checked');
  let questMemo = '';
  let questDraft;
  if (questEvent) {
    questDraft = postedQuestMemo(questEvent);
    if (questDraft && !questDraft.stopped) {
      questMemo = `<section><h2>Vision Quest memo</h2><p>${escape(questDraft.recommendation)}: ` +
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
  const draftSpec = questDraft && !questDraft.stopped ? questDraft.spec : { must: [], how_we_know: [], out_of_scope: [] };
  const fill = key => escape(draftSpec[key].join('\n'));
  const specForm = `<form data-event="specced"><h2>Write the spec</h2>${rules2 ? `<input type="hidden" name="see_hash" value="${escape(context.seeHash)}">` : ''}` +
    `<label>Must do<textarea name="must" required>${fill('must')}</textarea></label>` +
    `<label>How we'll know<textarea name="how_we_know" required>${fill('how_we_know')}</textarea></label>` +
    `<label>Out of scope<textarea name="out_of_scope">${fill('out_of_scope')}</textarea></label>` +
    '<button>SPEC IT!</button></form>';
  if ((item.state === 'CHECKED' || (rules2 && item.state === 'SEEN')) && context.steward === person) action = specForm;
  if (item.state === 'SUBMITTED') {
    const packetBody = item.packet ? `<pre>${escape(item.packet)}</pre>` : '';
    action = `<section><h2>Decision packet</h2><p>Research: no source connected, nothing checked.</p>${packetBody}</section>` +
      (leader && context.steward !== person ? `<form data-approve="true"><h2>Decide</h2><input type="hidden" name="spec_hash" value="${escape(context.specHash)}"><input type="hidden" name="packet_hash" value="${escape(context.sent.packetHash)}"><label>Reason for your decision<textarea name="reason" required minlength="12"></textarea></label><label>Cap in dollars<input name="cap_usd" type="number" min="0" step="0.01" required></label><label>How many people need to say it helps?<input name="quorum" type="number" min="1" required></label><label>Re-enter your password<input name="password" type="password" required></label><button>Approve the try</button></form><form data-event="returned"><label>What needs to change?<input name="note" required minlength="12"></label><button>Return the spec</button></form>` : '');
  }
  if (item.state === 'SPECCED' && !rules2 && leader && context.steward !== person)
    action = `<form data-approve="true"><h2>Decide</h2><p>Approval freezes the cap. The configured provider and its worst-case micro-dollar estimate are shown by the gateway administrator before this screen is used.</p><input type="hidden" name="spec_hash" value="${escape(context.specHash)}"><input type="hidden" name="expected_seq" value="${events.length}"><label>Cap in dollars<input name="cap_usd" type="number" min="0" step="0.01" required></label><label>How many people need to say it helps?<input name="quorum" type="number" min="1" required></label><label>Re-enter your password<input name="password" type="password" required></label><button>Approve the try</button></form><form data-event="returned"><label>What needs to change?<input name="note" required></label><button>Return the spec</button></form>`;
  if (item.state === 'SENDING' && (leader || context.steward === person))
    action = `<form data-artifact="true"><h2>Deliver the try</h2><label>One HTML document<textarea name="html" required></textarea></label><button>Deliver the try</button></form>`;
  if (item.state === 'TRYING') {
    const canVote = !context.ineligibleHelpers.includes(person);
    // A model-built try gets no script permission in its frame. A hand-delivered try keeps its frame.
    const modelTry = events.some(event => event.type === 'tried' && event.artifact_hash === context.artifact && event.model_output === true);
    const frameSandbox = modelTry ? 'sandbox=""' : 'sandbox="allow-scripts"';
    action = `<iframe title="Playable try" ${frameSandbox} src="/api/items/${encodeURIComponent(item.id)}/artifact/${encodeURIComponent(context.artifact)}"></iframe>${canVote ? `<form data-event="helped"><input type="hidden" name="artifact_hash" value="${escape(context.artifact)}"><button>It helps</button></form>` : '<p>You helped shape this one, so others say whether it helps.</p>'}${context.steward === person ? '<form data-steer="true"><h2>Adopt as builder instruction</h2><label>Instruction<textarea name="instruction" required></textarea></label><button>Adopt as builder instruction</button></form>' : ''}`;
  }
  if (item.state === 'HELPS')
    action = '<p class="helps">People who do this work said it helps.</p>';
  if (item.state === 'SHELVED')
    action = `<p>This was shelved: ${escape(current?.reason || '')}</p>`;
  if (item.state === 'CHECKED' && questDraft && questDraft.recommendation !== 'BUILD') {
    action = '<p>No build is proposed. Ask the decision owner to review the existing option.</p>';
  }
  const shelve =
    !['HELPS', 'SHELVED'].includes(item.state) && (leader || context.steward === person)
      ? `<form data-event="shelved"><label>Why shelve it?<input name="reason" required></label><button>Shelve with a reason</button></form>`
      : '';
  const anchor = rules2 ? { kind: 'see', hash: context.seeHash } : context.artifact ? { kind: 'artifact', hash: context.artifact } :
    context.specHash ? { kind: 'spec', hash: context.specHash } : null;
  const comment = rules2
    ? `<form data-event="commented"><h2>Join the thread</h2><label>Comment<textarea name="comment" required maxlength="4000"></textarea></label><label>Type<select name="kind"><option value="comment">Comment</option><option value="question">Question</option><option value="concern">Concern</option></select></label><input type="hidden" name="anchor_kind" value="see"><input type="hidden" name="anchor_hash" value="${escape(context.seeHash)}"><button>Post comment</button></form>`
    : `<form data-event="commented"><h2>Comment</h2><label>Comment<textarea name="comment" required maxlength="4000"></textarea></label>${anchor ? `<input type="hidden" name="anchor_kind" value="${anchor.kind}"><input type="hidden" name="anchor_hash" value="${escape(anchor.hash)}"><p>Attached to the current ${anchor.kind} version.</p>` : '<p>There is no spec version yet.</p>'}<button>Post comment</button></form>`;
  const revisions = rules2 ? events.filter(event => event.type === 'revised').map((event, index) => `<li>SEE v${index + 2}: ${escape(event.text)}</li>`).join('') : '';
  const revise = rules2 && context.steward === person ? `<form data-event="revised"><h2>Revise SEE</h2><input type="hidden" name="base_hash" value="${escape(context.seeHash)}"><label>Current SEE<textarea name="text" required maxlength="4000">${escape(events.filter(event => event.type === 'revised').at(-1)?.text || firstEvent.original)}</textarea></label><button>Save revision</button></form>` : '';
  const see = rules2 ? `<section><h2>Original</h2><p>${escape(firstEvent.original)}</p><p>Hash ${escape(firstEvent.body_hash)}, posted ${escape(firstEvent.at)}</p><h2>Current SEE v${escape(context.seeVersion)}</h2><p>${escape(events.filter(event => event.type === 'revised').at(-1)?.text || firstEvent.original)}</p><h2>Version history</h2><ol><li>SEE v1: ${escape(firstEvent.original)}</li>${revisions}</ol>${context.specHash ? `<p><a class="button" href="/items/${encodeURIComponent(item.id)}/spec">Open the spec</a></p>` : ''}</section>` : '';
  const fork = rules2 ? `<form data-fork="true"><h2>Fork</h2><label>Why try another direction?<input name="reason" required maxlength="2000"></label><button>Fork</button></form>` : '';
  const checkin = `<form data-event="checked_in"><h2>Check-in</h2><label>What changed?<input name="note" required maxlength="2000"></label><button>Post check-in</button></form>`;
  const effortStatus = (item.effort || []).map(job => `<p>Effort: ${escape(job.kind)} is ${escape(job.state)}${job.last_error ? ` (${escape(job.last_error)})` : ''}.</p>`).join('');
  const instructions = events.filter(event => event.type === 'steered' && event.approval === context.approval)
    .map(event => `<li>${escape(event.instruction)}${event.source ? ` (from ${escape(event.source)})` : ''}</li>`).join('');
  return shell(
    problem,
    '<p><a href="/">Back to the work</a></p>' +
      `<p class="stage">${stages[item.state]}</p><h1>${escape(problem)}</h1>` +
      `<p>${progress({ helpers: context.helpers.length, quorum: context.quorum })}</p>${effortStatus}${see}${questMemo}${specSummary}${revise}${action}${instructions ? `<section><h2>Builder instructions</h2><ol>${instructions}</ol></section>` : ''}${fork}${shelve}${checkin}${comment}` +
      `<h2>${rules2 ? 'Thread' : 'Comments'}</h2>${rules2 ? (renderThread(events, { ...context, steward: context.steward === person ? context.steward : null }) || '<p>No comments yet.</p>') : `<ol>${anchoredComments || '<li>No comments yet.</li>'}</ol>`}<h2>What happened</h2><ol>${events.filter(event => event.type !== 'commented' && event.type !== 'revised').map(event => `<li>${eventWords(event)}</li>`).join('')}</ol>`,
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
