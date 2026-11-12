// Page wiring only. The rules live in lib/machine.js (a generated copy of core/machine.js).
import { createLog, restoreLog } from './lib/log.js';
import { createSession, perform, summary, checkKinds, restoreArtifacts } from './lib/flow.js';
import { item, makeRoster } from './lib/roster.js';
import { tourSteps, playStep } from './lib/tour.js';
import { renderEvents, renderRefusals, renderResult, renderStatus, renderTour, renderWho } from './lib/render.js';
import { answerQuest, deriveQuest, emptyQuest } from './lib/vision-quest.js';

const storageKey = 'sss-demo-v1';
const $ = id => document.getElementById(id);
let busy = false;
const app = { session: null, current: 'maya', result: null, resultActor: 'maya', played: [] };

const storeHadValue = () => { try { return localStorage.getItem(storageKey) !== null; } catch { return false; } };
const store = {
  read() { try { return JSON.parse(localStorage.getItem(storageKey)); } catch { return null; } },
  write(value) { try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* storage off: stay in memory */ } },
  clear() { try { localStorage.removeItem(storageKey); } catch { /* nothing to clear */ } },
};

function newSession() {
  const roster = makeRoster();
  return createSession({ log: createLog({ roster, item }), roster });
}

function save() {
  if (!$('persist').checked) return;
  store.write({ log: app.session.log.toJSON(), artifacts: [...app.session.artifacts] });
}

function paint() {
  renderWho(document, $('who'), app.current);
  renderStatus(document, $('status'), summary(app.session));
  renderResult(document, $('result'), app.result, app.resultActor);
  renderEvents(document, $('events'), app.session.log.rows());
  renderRefusals(document, $('refusals'), app.session.refusals);
  renderTour(document, $('tour-out'), app.played, tourSteps.length);
  $('tour-next').disabled = busy || app.played.length >= tourSteps.length;
  $('tour-all').disabled = busy;
  $('tour-start').disabled = busy;
}

async function act(action, input) {
  if (busy) return;
  app.resultActor = app.current;
  app.result = await perform(app.session, app.current, action, input);
  save();
  paint();
}

const field = (form, name) => form.elements[name]?.value ?? '';

function wire() {
  $('quest-example').addEventListener('click', () => {
    let quest = emptyQuest('fictional-maya');
    const answers = { occurrence: 'A fictional refund is copied twice.', problem: 'A fictional team copies refunds twice.', chair: 'The workaround feels safe.', depends: 'A fictional billing screen.', baseline: 'Fictional duplicate effort.', better: 'One small fictional list.', have: 'unavailable', pay_for: 'unavailable', free: 'unavailable', setting: 'unavailable', playback: 'yes', priority: 'Keep the current queue.', frontline: 'Exceptions may be missed.', skeptic: 'Past changes caused noise.', strongest: 'It may not save enough time.', first_test: 'Try one read-only list.', stop: 'Stop if it misses a refund.', owner: 'Fictional queue lead.', informed: 'Fictional refund team.', risk: 'low', reversible: 'Turn off the list.', out_scope: 'No billing changes.', impact: '3', repeat: '4', control: '4', evidence: '3', approach: 'build' };
    for (const [key, value] of Object.entries(answers)) quest = answerQuest(quest, key, value);
    const memo = deriveQuest(quest);
    $('quest-example-out').textContent = `Fictional result: ${memo.recommendation}. ${memo.reason}\n${JSON.stringify(memo.memo, null, 2)}`;
  });
  $('who').addEventListener('change', event => {
    if (event.target.name === 'who') { app.current = event.target.value; app.result = null; paint(); }
  });
  $('form-post').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    const checks = {};
    for (const kind of checkKinds) checks[kind] = { on: form.elements[kind].checked, note: field(form, `${kind}_note`) };
    act('post', { problem: field(form, 'problem'), verdict: field(form, 'verdict'), checks });
  });
  $('form-spec').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    act('spec', { must: field(form, 'must'), how_we_know: field(form, 'how_we_know'), out_of_scope: field(form, 'out_of_scope') });
  });
  $('form-approve').addEventListener('submit', event => {
    event.preventDefault();
    act('approve', { cap: field(event.target, 'cap'), quorum: field(event.target, 'quorum') });
  });
  $('form-deliver').addEventListener('submit', event => {
    event.preventDefault();
    act('deliver', { text: field(event.target, 'text') });
  });
  $('btn-help').addEventListener('click', () => act('help'));
  $('btn-done').addEventListener('click', () => act('done'));
  $('form-shelve').addEventListener('submit', event => {
    event.preventDefault();
    act('shelve', { reason: field(event.target, 'reason') });
  });
  $('verify').addEventListener('click', async () => {
    const out = await app.session.log.verify();
    $('verify-out').textContent = out.ok
      ? `The chain checks out. ${out.events} events, each hash recomputed from the one before it.`
      : `The chain is broken at event ${out.seq} (${out.reason}).`;
  });
  $('tamper').addEventListener('click', () => {
    const seq = app.session.log.length;
    $('verify-out').textContent = seq && app.session.log.tamper(seq)
      ? `Event ${seq} was edited in memory. Press "Verify the chain" to see it caught.`
      : 'There are no events to edit yet.';
  });
  $('reset').addEventListener('click', () => { if (!busy) reset(); });
  $('persist').addEventListener('change', () => {
    if ($('persist').checked) save(); else store.clear();
  });
  // The tour buttons are locked while a tour runs, so two clicks can't interleave two tours.
  const locked = async work => {
    if (busy) return;
    busy = true; paint();
    try { await work(); } finally { busy = false; save(); paint(); }
  };
  $('tour-start').addEventListener('click', () => locked(async () => {
    reset();
    app.played = [await playStep(app.session, 0)];
    app.result = null;
    $('tour-out').focus();
  }));
  $('tour-next').addEventListener('click', () => locked(async () => {
    if (!app.played.length) { reset(); }
    app.played.push(await playStep(app.session, app.played.length));
  }));
  $('tour-all').addEventListener('click', () => locked(async () => {
    reset();
    for (let index = 0; index < tourSteps.length; index += 1) app.played.push(await playStep(app.session, index));
    $('tour-out').focus();
  }));
}

function reset() {
  app.session = newSession();
  app.result = null;
  app.played = [];
  $('verify-out').textContent = '';
  store.clear();
  save();
  paint();
}

async function start() {
  app.session = newSession();
  const saved = store.read();
  if (saved) {
    const restored = await restoreLog(saved.log, { roster: app.session.roster, item });
    if (restored) {
      app.session.log = restored;
      app.session.artifacts = await restoreArtifacts(restored, saved.artifacts);
      $('persist').checked = true;
    } else {
      store.clear();
      app.result = { status: 'note', message: "What this browser had saved didn't check out (it was damaged or edited), so it was thrown away. You're starting fresh." };
    }
  } else if (saved === null && storeHadValue()) {
    store.clear();
    app.result = { status: 'note', message: "What this browser had saved couldn't be read, so it was thrown away. You're starting fresh." };
  }
  wire();
  paint();
}

start();
