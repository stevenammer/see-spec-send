import { STEPS, answerQuest, checkedFromQuest, compactQuest, deriveQuest,
  emptyQuest, nextQuestion, playback, safetyStop, squirrel, validateQuest } from './vision-quest.js';
import { clearPending, loadDraft, loadPending, restoreDraft, saveDraft, savePending,
  sealQuest, readDraftHead, loadRevision, archivePending, loadArchivedPending,
  discardArchivedPending, startAnotherQuest, questHistory, postedQuestItem, markQuestPosted } from './quest-storage.js';

const root = document.getElementById('quest');
const person = root.dataset.person;
const content = document.getElementById('quest-content');
const status = document.getElementById('quest-status');
const error = document.getElementById('quest-error');
let saved;
let writing = Promise.resolve();
let activeForm;
let stopped = false;
let staleRecovery;
let lifecycleBusy = false;
let tab;
try {
  tab = sessionStorage.getItem('sss-quest-tab');
  if (!tab) { tab = crypto.randomUUID(); sessionStorage.setItem('sss-quest-tab', tab); }
} catch { /* Saving will fail visibly if this browser can't retain a tab identity. */ }
const lock = navigator.locks ? (name, action) => navigator.locks.request(name, action) : null;
const node = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};
function fail(err) {
  error.textContent = `${err.message} Keep this tab open and export your draft if possible.`;
  status.textContent = 'Not saved. Your current input is still in this tab.';
}
async function persist(doc, restore = false, bytes) {
  const run = writing.then(async () => {
    saved = restore ? await restoreDraft(localStorage, bytes, person, saved.head, lock) :
      await saveDraft(localStorage, doc, saved.head, lock);
    if (tab) clearPending(localStorage, person, tab);
    error.textContent = '';
    status.textContent = 'Saved in this browser. Readback and SHA check passed.';
  });
  writing = run.catch(() => {});
  await run;
}
function field(step, answer = {}) {
  const form = node('form');
  form.dataset.questForm = '';
  form.dataset.questStep = step.key;
  const label = node('label', step.question);
  const input = node(step.options ? 'select' : 'textarea');
  input.name = 'answer';
  input.required = true;
  input.maxLength = 2000;
  if (step.options) {
    for (const [value, text] of step.options) {
      const option = node('option', text);
      option.value = value;
      input.append(option);
    }
  }
  if (answer.value !== undefined) input.value = answer.value;
  label.append(input);
  form.append(label);
  if (['have', 'pay_for', 'free', 'setting'].includes(step.key)) {
    const noteLabel = node('label', 'Short note from this check (optional)');
    const note = node('textarea');
    note.name = 'note';
    note.maxLength = 2000;
    note.value = answer.note || '';
    noteLabel.append(note);
    form.append(noteLabel);
  }
  const button = node('button', 'Save answer and continue');
  form.append(button);
  form.addEventListener('input', () => {
    activeForm = { form, step };
    const data = new FormData(form);
    const pending = { step: step.key, value: String(data.get('answer') || ''),
      note: String(data.get('note') || '') };
    try {
      if (!tab) throw Error('A stable tab identity is unavailable.');
      savePending(localStorage, person, tab, saved.head, pending);
      saved.doc = { ...saved.doc, pending };
      status.textContent = 'Unsent input saved for recovery. Not a submitted or SHA-sealed answer yet.';
      const reviewed = content.querySelector('[name=reviewed]');
      if (reviewed) reviewed.checked = false;
      error.textContent = '';
    } catch (err) { fail(err); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    button.disabled = true;
    try {
      await writing;
      const data = new FormData(form);
      const next = answerQuest(saved.doc, step.key, String(data.get('answer') || ''),
        String(data.get('note') || ''));
      await persist(next);
      render();
    } catch (err) { fail(err); }
    finally { button.disabled = false; }
  });
  return form;
}
function render() {
  content.replaceChildren();
  activeForm = null;
  renderHistory();
  const postedItem = postedQuestItem(localStorage, person, saved.head);
  if (postedItem) {
    content.append(node('h2', 'This quest was posted'));
    const link = node('a', 'Open the checked problem');
    link.href = `/items/${encodeURIComponent(postedItem)}`;
    content.append(link, node('p', 'Your draft and earlier revisions remain here. Start another quest when ready.'));
    return;
  }
  stopped = safetyStop(saved.doc);
  if (stopped) {
    content.append(node('h2', 'This needs a human'), node('p', deriveStopped()));
    return;
  }
  const step = nextQuestion(saved.doc);
  const currentAnswers = validateQuest(saved.doc).answers;
  if (currentAnswers.problem && !currentAnswers.playback) {
    content.append(node('p', `A small first read, open to correction: ` +
      `${currentAnswers.problem.value}. This is your account, not a verified conclusion.`));
  }
  if (saved.doc.turns.length && saved.doc.turns.length % 5 === 0) {
    content.append(node('p', 'Checkpoint: are we still describing the real problem, ' +
      'rather than agreeing with a favorite fix? Corrections stay alongside the originals.'));
  }
  if (step) {
    content.append(node('p', `Question ${STEPS.indexOf(step) + 1} of ${STEPS.length}`));
    if (step.key === 'playback') content.append(node('pre', playback(saved.doc)));
    const answers = validateQuest(saved.doc).answers;
    const pending = saved.doc.pending?.step === step.key ? saved.doc.pending : null;
    const form = field(step, pending || answers[step.key]);
    content.append(form);
    activeForm = { form, step };
  } else {
    const draft = deriveQuest(saved.doc);
    content.append(node('h2', 'Review your memo'), node('h3', draft.recommendation),
      node('p', draft.reason), node('p', 'These are your reported claims, not verified facts.'),
      reviewMemo(draft));
    if (draft.recommendation === 'KILL') {
      content.append(node('p', 'Keep or export this memo. No proposal will be posted while this is parked.'));
    } else if (saved.doc.pending) {
      content.append(node('p', 'Save or discard your unsent correction before reviewing the post.'));
    } else {
      const form = node('form');
      form.dataset.questForm = '';
      if (draft.recommendation === 'PROCESS CHANGE') {
        content.append(node('p', 'Posting files this as a setting, the nearest verdict the workflow has. ' +
          'The memo keeps it as a process change.'));
      }
      const label = node('label', 'I reviewed my answers and want to post this checked problem.');
      const check = node('input');
      check.type = 'checkbox';
      check.required = true;
      check.name = 'reviewed';
      label.prepend(check);
      const button = node('button', 'Post my checked problem');
      form.append(label, button);
      let posting = false;
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!check.checked || posting || lifecycleBusy) return;
        posting = true;
        lifecycleBusy = true;
        root.inert = true;
        button.disabled = true;
        try {
          await writing;
          const postingDoc = structuredClone(saved.doc);
          const postingHead = saved.head;
          if (readDraftHead(localStorage, person) !== postingHead) throw Error('Another tab changed this draft. Reload first.');
          checkedFromQuest(postingDoc, person);
          const response = await fetch('/api/me');
          if (!response.ok) throw Error('Sign in again before posting.');
          const me = await response.json();
          if (me.id !== person) throw Error('The signed-in person changed. Reload first.');
          const posted = await fetch('/api/items', { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf },
            body: JSON.stringify({ quest: postingDoc }) });
          if (!posted.ok) throw Error('The proposal was refused. Your draft is still here.');
          const out = await posted.json();
          markQuestPosted(localStorage, person, postingHead, out.id);
          location.assign(`/items/${encodeURIComponent(out.id)}`);
        } catch (err) { fail(err); button.disabled = false; posting = false; }
        finally { lifecycleBusy = false; root.inert = false; }
      });
      content.append(form);
    }
  }
  corrections();
}
function reviewMemo(draft) {
  const section = node('section');
  const entries = [
    ['Problem as you described it', draft.checked.problem],
    ['Last occurrence', draft.memo.occurrence], ['Reported baseline', draft.memo.baseline],
    ['Decision owner', draft.memo.decisionOwner], ['Who needs to know', draft.memo.informed],
    ['Risk, as you described it', draft.memo.risk], ['How to undo it', draft.memo.reversibility],
    ['Strongest reason not to proceed', draft.memo.strongestReasonNot],
    ['Stop the test if', draft.memo.stopCondition],
    ['Priority challenge', draft.memo.challenges.priority],
    ['Frontline challenge', draft.memo.challenges.frontline],
    ['Skeptic challenge', draft.memo.challenges.skeptic],
    ['Proposed test, still a draft', draft.spec.must.join('\n')],
    ["How we'll know", draft.spec.how_we_know.join('\n')],
    ['Outside this test', draft.spec.out_of_scope.join('\n')],
    ['Independently verified here', 'Nothing. A person confirming their account is not verification.'],
    ['Confirmed assumption', draft.memo.confirmedAssumptions.join(' ')],
    ['Still unknown', draft.memo.unknowns.join(' ')],
    ['Your estimated signal', `${draft.signal.score}/100, threshold ${draft.signal.threshold}. ` +
      `Weights are provisional: impact ${draft.signal.weights.impact}%, recurrence ${draft.signal.weights.repeat}%, ` +
      `control ${draft.signal.weights.control}%, reported evidence ${draft.signal.weights.evidence}%.`],
  ];
  for (const [label, value] of entries) section.append(node('h3', label), node('p', value));
  section.append(node('h3', 'What you checked'));
  const labels = { have: 'What the team already has', pay_for: 'Tools already paid for',
    free: 'Free options', setting: 'A setting or field' };
  for (const check of draft.checked.looked) {
    const colon = check.indexOf(':');
    section.append(node('p', `${labels[check.slice(0, colon)] || 'Existing option'}: ` +
      check.slice(colon + 1).trim()));
  }
  return section;
}
function deriveStopped() {
  return 'Stop this analysis. Take this concern to an appropriate authorized human. ' +
    "This guide can't assess people, medical needs, or disciplinary decisions. " +
    'Your draft is retained. It cannot be posted as a normal proposal.';
}
function corrections() {
  const { answers } = validateQuest(saved.doc);
  const answered = STEPS.filter(step => answers[step.key]);
  if (!answered.length) return;
  if (saved.doc.pending) {
    const discard = node('button', 'Discard only my unsent input');
    discard.type = 'button';
    discard.addEventListener('click', () => {
      if (!confirm('Discard only this unsent input? Submitted answers stay unchanged.')) return;
      try {
        clearPending(localStorage, person, tab);
        delete saved.doc.pending;
        render();
        status.textContent = 'Unsent input discarded. Submitted answers are unchanged.';
      } catch (err) { fail(err); }
    });
    content.append(discard);
  }
  const details = node('details');
  details.append(node('summary', 'Review or correct an earlier answer'));
  const label = node('label', 'Choose the answer to correct');
  const select = node('select');
  for (const step of answered) {
    const option = node('option', step.question);
    option.value = step.key;
    select.append(option);
  }
  label.append(select);
  const edit = node('div');
  const show = () => {
    const pending = saved.doc.pending?.step === select.value ? saved.doc.pending : null;
    edit.replaceChildren(field(STEPS.find(step => step.key === select.value),
      pending || answers[select.value]));
  };
  if (saved.doc.pending && answers[saved.doc.pending.step]) {
    select.value = saved.doc.pending.step;
    details.open = true;
  }
  select.addEventListener('change', show);
  show();

  details.append(label, edit);
  content.append(details);
}
async function recoveryDoc() {
  await writing;
  if (!saved || saved.broken) throw Error('Restore a verified export before exporting this draft.');
  if (!activeForm) return saved.doc;
  const data = new FormData(activeForm.form);
  return { ...saved.doc, pending: { step: activeForm.step.key,
    value: String(data.get('answer') || ''), note: String(data.get('note') || '') } };
}
function download(bytes, filename) {
  const link = node('a');
  link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function renderHistory() {
  const history = document.getElementById('quest-history');
  history.replaceChildren();
  const heads = questHistory(localStorage, person);
  if (!heads.length) return;
  history.append(node('p', `${heads.length} earlier quest(s) retained in this browser.`));
  heads.forEach((head, index) => {
    const button = node('button', `Export earlier quest ${index + 1}`);
    button.type = 'button';
    button.addEventListener('click', async () => {
      try { download(await sealQuest(await loadRevision(localStorage, person, head)), 'vision-quest-history.json'); }
      catch (err) { fail(err); }
    });
    history.append(button);
  });
}
document.getElementById('quest-new').addEventListener('click', async () => {
  if (lifecycleBusy || !saved || saved.broken) return;
  if (!confirm('Start another quest? This quest stays in your browser history, including any unsent input.')) return;
  lifecycleBusy = true;
  root.inert = true;
  try {
    const doc = await recoveryDoc();
    // Seal unsent input too before archiving, so a restart never loses visible work.
    if (JSON.stringify(doc) !== JSON.stringify(saved.doc) || doc.pending) await persist(doc);
    saved = await startAnotherQuest(localStorage, person, saved.head, lock);
    if (tab) clearPending(localStorage, person, tab);
    error.textContent = '';
    document.getElementById('quest-note').textContent = '';
    status.textContent = 'New quest saved. Earlier quests remain in browser history.';
    render();
  } catch (err) { fail(err); }
  finally { lifecycleBusy = false; root.inert = false; }
});
document.getElementById('quest-export').addEventListener('click', async () => {
  try {
    const bytes = await sealQuest(await recoveryDoc());
    download(bytes, 'vision-quest.json');
  } catch (err) { fail(err); }
});
document.getElementById('quest-restore').addEventListener('change', async event => {
  if (lifecycleBusy) return;
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 125000) throw Error('The quest file is too large.');
    if (!confirm('Replace this active draft with your exported file? Prior saved revisions stay here.')) {
      return;
    }
    await writing;
    await persist(null, true, await file.text());
    render();
  } catch (err) { fail(err); }
  finally { event.target.value = ''; }
});
document.getElementById('quest-compact').addEventListener('click', () => {
  if (saved) document.getElementById('quest-note').textContent = compactQuest(saved.doc);
});
document.getElementById('quest-squirrel').addEventListener('click', () => {
  if (!saved) return;
  const signal = squirrel(saved.doc);
  document.getElementById('quest-note').textContent = signal.complete ?
    `Your estimated signal: ${signal.score}/100. Threshold: ${signal.threshold}. ${signal.note}` :
    'The signal checkpoint is not complete yet. No priority claim is being made.';
});
try {
  saved = await loadDraft(localStorage, person);
  let pending;
  let pendingError;
  let recoveryBlocked = false;
  try { staleRecovery = tab ? loadArchivedPending(localStorage, person, tab) : null; }
  catch (err) { pendingError = err; }
  try { pending = tab ? loadPending(localStorage, person, tab, saved.head) : null; }
  catch (err) {
    pendingError = err;
    if (err.recovery) {
      try {
        archivePending(localStorage, person, tab, err.recovery);
        staleRecovery = err.recovery;
      } catch (archiveError) { pendingError = archiveError; recoveryBlocked = true; }
    }
  }
  if (pending) saved.doc = { ...saved.doc, pending };
  status.textContent = saved.head ? 'Saved draft verified and restored.' :
    'No answers saved yet. Your first answer starts a draft.';
  render();
  content.inert = recoveryBlocked;
  if (pending) status.textContent = 'Unsent input recovered. Review it before submitting.';
  if (pendingError) {
    error.textContent = pendingError.message;
    status.textContent = 'Your current submitted draft is verified. Unsent recovery is separate.';
  }
  if (staleRecovery) {
    const recover = node('button', 'Export my older unsent recovery');
    recover.type = 'button';
    recover.addEventListener('click', async () => {
      try {
        const doc = await loadRevision(localStorage, person, staleRecovery.head);
        download(await sealQuest({ ...doc, pending: staleRecovery.pending }),
          'vision-quest-older-unsent.json');
      } catch (err) { fail(err); }
    });
    const original = node('pre', `Older unsent answer (${staleRecovery.pending.step}):\n` +
      staleRecovery.pending.value + '\n' + staleRecovery.pending.note);
    const discard = node('button', 'Discard my older unsent recovery');
    discard.type = 'button';
    discard.addEventListener('click', () => {
      if (!confirm('Discard this older unsent recovery? Export it first if you need it.')) return;
      try {
        discardArchivedPending(localStorage, person, tab);
        // Remove the raw slot only if it still contains this older recovery.
        try {
          const raw = loadPending(localStorage, person, tab, saved.head);
          if (!raw) clearPending(localStorage, person, tab);
        } catch (err) {
          if (JSON.stringify(err.recovery) === JSON.stringify(staleRecovery)) {
            clearPending(localStorage, person, tab);
          }
        }
        staleRecovery = null;
        recover.remove();
        original.remove();
        discard.remove();
      } catch (err) { fail(err); }
    });
    root.append(recover, original, discard);
  }
} catch (err) {
  try {
    saved = { doc: emptyQuest(person), head: readDraftHead(localStorage, person), broken: true };
  } catch { /* No writes are attempted when browser storage itself is unavailable. */ }
  fail(err);
}
