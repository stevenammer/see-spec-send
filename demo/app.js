// Page wiring only. The rules live in lib/machine.js (a generated copy of core/machine.js).
import { createVisionDemo } from './lib/vision.js';
import { people } from './lib/roster.js';
import { story } from './lib/story.js';
import { AFTER_REFUSAL_MS, AFTER_STEP_MS, readMs } from './lib/pace.js';
import { answerQuest, deriveQuest, emptyQuest } from './lib/vision-quest.js';
import { avatar, h, renderCan, renderQuorum, renderStages, renderThread, who, whyRefused } from './lib/ui.js';

const $ = id => document.getElementById(id);
let demo = createVisionDemo();
let refusals = [];
let busy = false;
let current = 'nick';
let freshSeq = 0;
let paused = false;
const quiet = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
// Waits ms of unpaused time. Reduced motion turns off smooth scrolling, never reading time: a caption still needs
// to be read. The clock stops while the visitor has pressed Pause.
const pause = ms => new Promise(resolve => {
  let left = ms;
  const tick = () => { if (!paused) left -= 100; if (left <= 0) resolve(); else setTimeout(tick, 100); };
  setTimeout(tick, 100);
});


const seeText = events => [...events].reverse().find(event => event.type === 'revised')?.text ?? events[0]?.original ?? '';
const split = text => {
  const clean = String(text).trim(); const stop = clean.search(/[.!?](\s|$)|\n/);
  const cut = stop > 0 && stop < 140 ? stop + 1 : Math.min(clean.length, 120);
  return { title: clean.slice(0, cut).trim(), rest: clean.slice(cut).trim() };
};

async function attempt(action, label, work) {
  if (busy && action !== 'story') return null;
  const out = await work();
  if (!out.ok) refusals.push({ after: demo.state().events.length, actor: current, attempt: label, reason: whyRefused(action, demo.state(), current), action });
  paint(out.ok ? 'ok' : 'refused', out);
  return out;
}

function paint(kind = null) {
  const state = demo.state(); const c = state.context; const posted = state.events.length > 0;
  $('empty').hidden = posted; $('post').hidden = !posted;
  $('composer').hidden = !posted || busy;
  $('side-name').textContent = who(current);
  if (posted) {
    const text = seeText(state.events);
    $('post-by').replaceChildren(avatar(document, c.originator || current), h(document, 'strong', { text: who(c.originator || current) }), h(document, 'span', { class: 'badge member', text: 'posted this' }), h(document, 'span', { class: 'badge tag', text: 'Refunds' }));
    const parts = split(text);
    $('post-title').textContent = parts.title;
    $('post-body').textContent = parts.rest;
    $('vote-count').textContent = String(c.helpers?.length ?? 0);
  }
  renderStages(document, $('stages'), c, posted);
  renderQuorum(document, $('side-quorum'), c);
  renderCan(document, $('can'), state, current);
  renderThread(document, $('thread'), state, refusals, current, { include: hash => attempt('include', 'Include a comment in the spec.', () => demo.include(current, hash)) });
  renderComposer(state);
  renderPeople();
  const newest = state.events.length;
  if (newest > freshSeq) { for (const node of $('thread').querySelectorAll('[data-seq]')) if (Number(node.getAttribute('data-seq')) > freshSeq) node.classList.add('fresh'); freshSeq = newest; }
  $('result').textContent = kind === 'refused' ? 'Refused. See the red card in the thread.' : '';
  $('play').disabled = busy; $('reset').disabled = busy; $('viewer').disabled = busy; $('pause').hidden = !busy;
}

function renderPeople() {
  const list = $('people'); list.replaceChildren();
  for (const person of people) {
    const button = h(document, 'button', { type: 'button', class: person.id === current ? 'person on' : 'person', 'data-person-button': person.id, 'aria-pressed': person.id === current ? 'true' : 'false' },
      avatar(document, person.id), h(document, 'span', { text: person.name }), h(document, 'span', { class: `badge ${person.leader ? 'leader' : 'member'}`, text: person.leader ? 'leader' : 'member' }));
    button.addEventListener('click', () => { if (!busy) { current = person.id; $('viewer').value = current; paint(); } });
    list.append(h(document, 'li', {}, button));
  }
}

function renderComposer(state) {
  const c = state.context; const root = $('composer-body'); root.replaceChildren();
  const finished = c.phase === 'HELPS';
  const isSteward = c.steward === current;
  if (finished) {
    root.append(h(document, 'div', { class: 'win' }, h(document, 'h2', { text: 'It helps.' }), h(document, 'p', { text: `${c.helpers.length} people who didn't shape it said so, and only then did it count. Start over to try to cheat your way there.` })));
    return;
  }
  const reply = h(document, 'form', { id: 'form-comment', class: 'stack' }, h(document, 'label', {}, `Reply as ${who(current)}`, h(document, 'textarea', { name: 'comment', required: true, maxlength: '300', placeholder: 'Add what you know, or ask a question.' })), h(document, 'button', { class: 'quiet', text: 'Reply' }));
  reply.addEventListener('submit', async event => { event.preventDefault(); const text = new FormData(reply).get('comment'); if (await attempt('comment', 'Reply.', () => demo.comment(current, String(text)))) {} });
  root.append(reply);
  if (!c.specHash) {
    const form = h(document, 'form', { id: 'form-spec', class: 'stack' }, h(document, 'label', {}, 'Write the spec: what does the fix have to do? One line each.', h(document, 'textarea', { name: 'must', required: true, maxlength: '600', text: 'Show each refund once.\nCatch a refund pasted twice.' })), h(document, 'label', {}, 'How will you know it worked?', h(document, 'input', { name: 'how', required: true, maxlength: '200', value: 'Nobody opens the spreadsheet anymore.' })), h(document, 'button', { class: 'primary', text: 'Write the spec' }), isSteward ? null : h(document, 'p', { class: 'fine', text: `Only ${who(c.steward || 'nick')} posted this, so only they write the spec. Try it anyway.` }));
    form.addEventListener('submit', event => { event.preventDefault(); attempt('spec', 'Write the spec.', () => demo.spec(current, String(new FormData(form).get('must')), String(new FormData(form).get('how')))); });
    root.append(form);
  } else if (!c.sent) {
    const send = h(document, 'button', { type: 'button', class: 'primary', text: 'Send it for a decision' });
    send.addEventListener('click', () => attempt('send', 'Send it.', () => demo.send(current)));
    root.append(h(document, 'div', { class: 'stack' }, h(document, 'p', { class: 'fine', text: 'The spec is written. Sending it freezes a packet, so a leader decides on exactly this.' }), send));
  } else if (!c.approver) {
    const form = h(document, 'form', { id: 'form-approve', class: 'stack' }, h(document, 'label', {}, 'A leader who didn\'t write it decides. Spend it?', h(document, 'textarea', { name: 'reason', required: true, minlength: '12', maxlength: '200', text: 'Small enough to try, and the spec is clear.' })), h(document, 'button', { class: 'primary', text: 'Spend it (approve a small try)' }));
    form.addEventListener('submit', event => { event.preventDefault(); attempt('approve', 'Spend it.', () => demo.approve(current, String(new FormData(form).get('reason')), 2)); });
    root.append(form);
  } else if (!c.artifact) {
    const build = h(document, 'button', { type: 'button', class: 'primary', text: 'Let the builder deliver the try' });
    build.addEventListener('click', () => attempt('deliver', 'Deliver the try.', () => demo.deliver()));
    root.append(h(document, 'div', { class: 'stack' }, h(document, 'p', { class: 'fine', text: 'In the real app an AI builds a small version in a locked box. Here it delivers a stand-in note.' }), build));
  } else {
    const helps = h(document, 'button', { type: 'button', class: 'primary', text: `It helps (as ${who(current)})` });
    helps.addEventListener('click', () => attempt('helps', 'Say it helps.', () => demo.helps(current)));
    const done = h(document, 'button', { type: 'button', class: 'danger', text: 'Try to mark it done by hand' });
    done.addEventListener('click', () => attempt('done', 'Mark it done.', () => demo.done(current)));
    root.append(h(document, 'div', { class: 'stack' }, h(document, 'p', { class: 'fine', text: 'Switch who you\'re viewing as, and see who can say it helps.' }), h(document, 'div', { class: 'row' }, helps, done)));
  }
}

function setViewer(id) { current = id; $('viewer').value = id; }

async function play() {
  if (busy) return;
  busy = true; demo = createVisionDemo(); refusals = []; freshSeq = 0; $('verify-out').textContent = '';
  setViewer('nick'); paint();
  for (const step of story) {
    setViewer(step.who === 'effort' ? current : step.who);
    $('caption').textContent = step.say; paint();
    await pause(readMs(step.say));
    const out = await step.run(demo);
    if (step.refuse) refusals.push({ after: demo.state().events.length, actor: step.who, attempt: step.refuse, reason: whyRefused(step.action, demo.state(), step.who), action: 'tour' });
    else if (!out.ok) { $('caption').textContent = `The demo stopped at a step it didn't expect: ${out.error}`; break; }
    paint(step.refuse ? 'refused' : 'ok');
    const last = $('thread').lastElementChild;
    last?.scrollIntoView?.({ block: 'center', behavior: quiet() ? 'auto' : 'smooth' });
    await pause(step.refuse ? AFTER_REFUSAL_MS : AFTER_STEP_MS);
  }
  $('caption').textContent = 'That\'s the whole rule. Two people who didn\'t shape it said it helps, and only then did it count. Now try it yourself. Start over, switch who you\'re viewing as, and try to cheat.';
  busy = false; setPaused(false); paint();
}

function setPaused(value) {
  paused = value;
  const button = $('pause');
  button.textContent = paused ? 'Resume' : 'Pause';
  button.setAttribute('aria-pressed', String(paused));
}

function reset() {
  if (busy) return;
  demo = createVisionDemo(); refusals = []; freshSeq = 0; current = 'nick';
  $('viewer').value = 'nick'; $('caption').textContent = ''; $('verify-out').textContent = ''; $('result').textContent = '';
  paint();
}

function start() {
  $('quest-example').addEventListener('click', () => {
    let quest = emptyQuest('fictional-nick');
    const answers = { occurrence: 'A fictional refund is copied twice.', problem: 'A fictional team copies refunds twice.', chair: 'The workaround feels safe.', depends: 'A fictional billing screen.', baseline: 'Fictional duplicate effort.', better: 'One small fictional list.', have: 'unavailable', pay_for: 'unavailable', free: 'unavailable', setting: 'unavailable', playback: 'yes', priority: 'Keep the current queue.', frontline: 'Exceptions may be missed.', skeptic: 'Past changes caused noise.', strongest: 'It may not save enough time.', first_test: 'Try one read-only list.', stop: 'Stop if it misses a refund.', owner: 'Fictional queue lead.', informed: 'Fictional refund team.', risk: 'low', reversible: 'Turn off the list.', out_scope: 'No billing changes.', impact: '3', repeat: '4', control: '4', evidence: '3', approach: 'build' };
    for (const [key, value] of Object.entries(answers)) quest = answerQuest(quest, key, value);
    const memo = deriveQuest(quest);
    $('quest-example-out').textContent = `Fictional result: ${memo.recommendation}. ${memo.reason}\n${JSON.stringify(memo.memo, null, 2)}`;
  });

  const select = $('viewer');
  for (const person of people) select.append(h(document, 'option', { value: person.id, text: `${person.name} (${person.leader ? 'leader' : 'member'})` }));
  select.value = current;
  select.addEventListener('change', () => { if (!busy) { current = select.value; paint(); } });
  $('form-post').addEventListener('submit', event => {
    event.preventDefault();
    const text = String(new FormData(event.target).get('original')).trim();
    attempt('post', 'Post it.', () => demo.post(current, text));
  });
  $('form-fork').addEventListener('submit', async event => {
    event.preventDefault();
    const reason = String(new FormData(event.target).get('reason'));
    const out = await attempt('fork', 'Fork it.', () => demo.fork(current, reason));
    if (out?.ok) { refusals = []; freshSeq = 0; paint(); }
  });
  $('reuse').addEventListener('click', () => attempt('reuse', 'Reuse the old approval.', () => demo.parentApproval()));
  $('verify').addEventListener('click', async () => {
    const out = await demo.verify();
    $('verify-out').textContent = out.ok ? `The chain checks out. ${out.events} events, each hash recomputed from the one before it.` : `The chain is broken at event ${out.seq} (${out.reason}).`;
  });
  $('tamper').addEventListener('click', () => {
    const seq = demo.tamper();
    $('verify-out').textContent = seq ? `Event ${seq} was edited in memory. Press "Verify the chain" to see it caught.` : 'There are no events to edit yet.';
  });
  // The header wraps to two rows on a phone. Keep the narration caption just below it, never underneath it.
  const header = document.querySelector('header.top');
  const fitCaption = () => document.documentElement.style.setProperty('--top-h', `${header?.offsetHeight ?? 58}px`);
  fitCaption(); window.addEventListener('resize', fitCaption);
  $('play').addEventListener('click', play);
  $('pause').addEventListener('click', () => setPaused(!paused));
  $('reset').addEventListener('click', reset);
  paint();
}

start();
