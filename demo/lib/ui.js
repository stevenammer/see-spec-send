// Draws the thread. Everything here is display: who may do what is decided by the machine, never by this file.
// All text goes in as text nodes. Nothing a visitor types is ever parsed as markup.
import { nameOf, people } from './roster.js';

export function h(doc, tag, props = {}, ...kids) {
  const el = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : doc.createTextNode(String(kid)));
  return el;
}

const roleOf = id => people.find(person => person.id === id)?.leader ? 'leader' : 'member';
export const who = id => (id === 'effort' ? 'Effort' : nameOf(id));

export function avatar(doc, id, size = '') {
  return h(doc, 'span', { class: `avatar ${size}`.trim(), 'data-person': id, 'aria-hidden': 'true' }, id === 'effort' ? 'AI' : nameOf(id).slice(0, 1));
}

function byline(doc, id, extras = []) {
  return h(doc, 'div', { class: 'byline' }, avatar(doc, id), h(doc, 'strong', { text: who(id) }),
    id === 'effort' ? h(doc, 'span', { class: 'badge ai', text: 'AI, a stand-in here' }) : h(doc, 'span', { class: `badge ${roleOf(id)}`, text: roleOf(id) }),
    ...extras);
}

export const stages = [
  { key: 'see', label: 'See it', done: c => c.rules !== undefined },
  { key: 'spec', label: 'Spec it', done: c => !!c.specHash },
  { key: 'send', label: 'Send it', done: c => !!c.sent },
  { key: 'spend', label: 'Spend it', done: c => !!c.approver },
  { key: 'try', label: 'Try it', done: c => !!c.artifact },
  { key: 'helps', label: 'Helps', done: c => c.phase === 'HELPS' },
];

export function renderStages(doc, root, context, posted) {
  root.replaceChildren();
  const list = posted ? stages : [];
  const current = list.findIndex(stage => !stage.done(context));
  list.forEach((stage, index) => {
    const state = stage.done(context) ? 'done' : index === current ? 'now' : 'todo';
    root.append(h(doc, 'li', { class: `stage ${state}`, 'aria-current': state === 'now' ? 'step' : false },
      h(doc, 'span', { class: 'stage-dot', 'aria-hidden': 'true' }, state === 'done' ? '✓' : String(index + 1)), h(doc, 'span', { text: stage.label })));
  });
}

export function renderQuorum(doc, root, context) {
  root.replaceChildren();
  const need = context.quorum ?? 2; const have = context.helpers?.length ?? 0;
  const live = !!context.approver;
  root.append(h(doc, 'p', { class: 'quorum-line', text: live ? `${have} of ${need} people have said it helps` : 'No try yet. The count starts once a leader approves.' }));
  if (live) root.append(h(doc, 'div', { class: 'dots', role: 'img', 'aria-label': `${have} of ${need}` },
    Array.from({ length: need }, (_, index) => h(doc, 'span', { class: index < have ? 'dot on' : 'dot' }))));
}

// What the current person could do right now, straight from the rules' own fields.
export function renderCan(doc, root, state, person) {
  root.replaceChildren();
  const c = state.context; const posted = state.events.length > 0;
  const leader = roleOf(person) === 'leader';
  const items = [
    ['Write the spec', !posted ? ['no', 'Nothing is posted yet.'] : c.steward === person ? ['yes', 'You posted it, so it\'s yours to spec.'] : ['no', 'Only the person who posted it writes the spec.']],
    ['Spend it (approve)', !c.sent ? ['no', 'Waits for a sent spec.'] : c.approver ? ['no', 'Already decided.'] : !leader ? ['no', 'Only a leader decides.'] : c.steward === person || c.specAuthor === person ? ['no', 'A leader can\'t approve their own spec.'] : ['yes', 'You\'re a leader and you didn\'t write it.']],
    ['Say it helps', !c.artifact ? ['no', 'There\'s no try to judge yet.'] : (c.ineligibleHelpers || []).includes(person) ? ['no', 'You shaped or approved this, so others judge it.'] : c.helpers?.includes(person) ? ['no', 'You already said it helps.'] : ['yes', 'You didn\'t shape it, so your say counts.']],
  ];
  for (const [label, [verdict, why]] of items) root.append(h(doc, 'li', { class: `can ${verdict}` },
    h(doc, 'span', { class: 'can-mark', 'aria-hidden': 'true' }, verdict === 'yes' ? '✓' : '✕'),
    h(doc, 'span', {}, h(doc, 'strong', { text: label }), ' ', h(doc, 'span', { class: 'why', text: why }))));
}

function card(doc, kind, id, ...body) { return h(doc, 'article', { class: `card ${kind}`, 'data-new': 'false' }, byline(doc, id), ...body); }

export function renderThread(doc, root, state, refusals, person, handlers) {
  root.replaceChildren();
  const c = state.context;
  state.events.forEach((event, index) => {
    const seq = index + 1;
    let node = null;
    if (event.type === 'commented' && event.actor === 'effort') {
      node = h(doc, 'article', { class: 'card ai-card' }, byline(doc, 'effort'), h(doc, 'p', { class: 'body', text: String(event.comment).replace(/^Fixture Effort \(AI\): /, '') }),
        h(doc, 'p', { class: 'fine', text: 'Canned text. No model is running in this demo.' }));
    } else if (event.type === 'commented') {
      const include = c.steward === person && !c.sent && event.body_hash ? h(doc, 'button', { type: 'button', class: 'link', 'data-include': event.body_hash, text: 'Include this in the spec and credit them' }) : null;
      node = h(doc, 'article', { class: 'card comment' }, byline(doc, event.actor), h(doc, 'p', { class: 'body', text: event.comment }), include);
      if (include) include.addEventListener('click', () => handlers.include(event.body_hash));
    } else if (event.type === 'revised') {
      const credited = state.events.find(other => other.type === 'commented' && other.body_hash === event.credits?.[0]?.comment)?.actor;
      node = h(doc, 'p', { class: 'sys', text: credited ? `${who(event.actor)} added ${who(credited)}'s comment to the problem and credited ${who(credited)}.` : `${who(event.actor)} added a comment to the problem and credited whoever wrote it.` });
    } else if (event.type === 'specced') {
      node = h(doc, 'article', { class: 'card spec' }, byline(doc, event.actor, [h(doc, 'span', { class: 'badge tag', text: 'Spec' })]),
        h(doc, 'h3', { text: 'What the fix has to do' }), h(doc, 'ul', { class: 'lines' }, (event.must || []).map(line => h(doc, 'li', { text: line }))),
        h(doc, 'h3', { text: 'How we\'ll know' }), h(doc, 'ul', { class: 'lines' }, (event.how_we_know || []).map(line => h(doc, 'li', { text: line }))));
    } else if (event.type === 'sent') {
      node = h(doc, 'p', { class: 'sys', text: `${who(event.actor)} sent it for a decision. A frozen packet was made, so the leader decides on exactly this.` });
    } else if (event.type === 'approved') {
      node = h(doc, 'article', { class: 'card decision' }, byline(doc, event.actor, [h(doc, 'span', { class: 'badge tag', text: 'Spent it' })]),
        h(doc, 'p', { class: 'body', text: event.reason }), h(doc, 'p', { class: 'fine', text: `Cap $${event.cap_usd}. ${event.quorum} ${event.quorum === 1 ? 'person has' : 'people have'} to say it helps.` }));
    } else if (event.type === 'tried') {
      node = h(doc, 'article', { class: 'card try' }, byline(doc, 'effort', [h(doc, 'span', { class: 'badge tag', text: 'Builder' })]),
        h(doc, 'p', { class: 'body', text: 'A small version is ready to try.' }),
        h(doc, 'div', { class: 'try-box' }, h(doc, 'strong', { text: 'Handoff note' }), h(doc, 'span', { text: 'In the real app this is a small working page you can click. Here it\'s a stand-in note.' })));
    } else if (event.type === 'helped') {
      node = h(doc, 'p', { class: 'sys good', text: `${who(event.actor)} said it helps.` });
    } else if (event.type === 'forked') {
      node = h(doc, 'p', { class: 'sys', text: `${who(event.actor)} forked this. A fork starts with no approval.` });
    }
    if (node) { node.setAttribute('data-seq', String(seq)); root.append(node); }
    for (const refusal of refusals.filter(entry => entry.after === seq)) root.append(refusalCard(doc, refusal));
  });
  for (const refusal of refusals.filter(entry => entry.after === 0)) root.append(refusalCard(doc, refusal));
}

function refusalCard(doc, refusal) {
  return h(doc, 'article', { class: 'card refused', role: 'status' }, h(doc, 'div', { class: 'byline' }, avatar(doc, refusal.actor), h(doc, 'strong', { text: who(refusal.actor) }), h(doc, 'span', { class: 'badge no', text: 'Refused' })),
    h(doc, 'p', { class: 'body', text: refusal.attempt }), h(doc, 'p', { class: 'why-line', text: refusal.reason }));
}

// Plain words for a refusal. The machine already said no; this only works out which rule it was, for the page.
export function whyRefused(action, state, person) {
  const c = state.context; const name = nameOf(person);
  const leader = roleOf(person) === 'leader';
  if (action === 'done') return 'There\'s no "done" event. Nothing marks an item finished by hand, and nobody can add one.';
  if (action === 'helps') {
    if (!c.artifact) return 'There\'s no try to judge yet. "It helps" only counts on a delivered try.';
    if (person === c.approver) return `${name} approved it, so other people have to judge whether it helps. A leader can't override that.`;
    if ((c.ineligibleHelpers || []).includes(person)) return `${name} shaped this one by writing the spec, so other people have to judge whether it helps.`;
    if (c.helpers?.includes(person)) return `${name} already said it helps. One person counts once.`;
  }
  if (action === 'approve') {
    if (!c.sent) return 'Nothing has been sent for a decision yet.';
    if (c.approver) return 'It was already decided.';
    if (!leader) return `${name} isn't a leader. Only a leader decides.`;
    if (person === c.steward || person === c.specAuthor) return `${name} wrote this spec, and a leader can't approve their own.`;
  }
  if (action === 'spec' || action === 'send' || action === 'include') return `Only ${nameOf(c.steward || person)}, who posted it, can do that.`;
  if (action === 'reuse') return 'A fork never inherits the approval. The old approval belongs to the old item.';
  if (action === 'deliver') return 'The builder only delivers after a leader approves.';
  return 'The rules don\'t allow that right now.';
}
