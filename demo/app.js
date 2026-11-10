// Page wiring only. The rules live in lib/machine.js (a generated copy of core/machine.js).
import { createLog, restoreLog } from './lib/log.js';
import { createSession, perform, summary, checkKinds } from './lib/flow.js';
import { item, makeRoster } from './lib/roster.js';
import { tourSteps, playStep } from './lib/tour.js';
import { renderEvents, renderRefusals, renderResult, renderStatus, renderTour, renderWho } from './lib/render.js';

const storageKey = 'sss-demo-v1';
const $ = id => document.getElementById(id);
const app = { session: null, current: 'maya', result: null, resultActor: 'maya', played: [] };

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
  $('tour-next').disabled = app.played.length >= tourSteps.length;
}

async function act(action, input) {
  app.resultActor = app.current;
  app.result = await perform(app.session, app.current, action, input);
  save();
  paint();
}

const field = (form, name) => form.elements[name]?.value ?? '';

function wire() {
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
  $('reset').addEventListener('click', () => reset());
  $('persist').addEventListener('change', () => {
    if ($('persist').checked) save(); else store.clear();
  });
  $('tour-start').addEventListener('click', async () => {
    reset();
    app.played = [await playStep(app.session, 0)];
    app.result = null;
    paint();
    $('tour-out').focus();
  });
  $('tour-next').addEventListener('click', async () => {
    if (!app.played.length) { reset(); }
    app.played.push(await playStep(app.session, app.played.length));
    save(); paint();
  });
  $('tour-all').addEventListener('click', async () => {
    reset();
    for (let index = 0; index < tourSteps.length; index += 1) app.played.push(await playStep(app.session, index));
    save(); paint();
    $('tour-out').focus();
  });
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
      for (const [hash, text] of saved.artifacts ?? []) {
        if (typeof hash === 'string' && typeof text === 'string') app.session.artifacts.set(hash, text);
      }
      $('persist').checked = true;
    } else store.clear();
  }
  wire();
  paint();
}

start();
