// Private decision reflection stays in this browser. It deliberately has no fetch,
// form POST, or connection to mentoring.
const FORMAT = 'see-spec-send/reflection-v1';
const keyFor = (person, item) => `sss-reflection:${encodeURIComponent(person)}:${encodeURIComponent(item)}`;
const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(text),
)), byte => byte.toString(16).padStart(2, '0')).join('');

const empty = (person, item, observed = '') => ({
  person, item, enabled: false, observed, notes: { known: '', changed: '', next: '' },
});
const validNotes = notes => notes && typeof notes === 'object' && !Array.isArray(notes) &&
  Object.keys(notes).sort().join(',') === 'changed,known,next' &&
  Object.values(notes).every(value => typeof value === 'string' && value.length <= 4000);
const validate = doc => {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.person !== 'string' ||
      typeof doc.item !== 'string' || typeof doc.enabled !== 'boolean' ||
      typeof doc.observed !== 'string' || doc.observed.length > 1000 || !validNotes(doc.notes)) {
    throw Error('The private reflection is invalid.');
  }
  return doc;
};

export async function sealReflection(doc) {
  validate(doc);
  return JSON.stringify({ format: FORMAT, sha256: await hash(JSON.stringify(doc)), data: doc });
}

export async function openReflection(bytes, person, item) {
  if (typeof bytes !== 'string' || new TextEncoder().encode(bytes).byteLength > 20000) {
    throw Error('Invalid private reflection file.');
  }
  const envelope = JSON.parse(bytes);
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'data,format,sha256' ||
      envelope.format !== FORMAT || typeof envelope.sha256 !== 'string' ||
      envelope.sha256 !== await hash(JSON.stringify(envelope.data))) {
    throw Error('The private reflection failed its integrity check.');
  }
  validate(envelope.data);
  if (envelope.data.person !== person || envelope.data.item !== item) throw Error('This private reflection belongs elsewhere.');
  return structuredClone(envelope.data);
}

export async function loadReflection(storage, person, item) {
  const key = keyFor(person, item), head = storage.getItem(key);
  if (head === null) return { doc: empty(person, item), head: null };
  if (!/^[a-f0-9]{64}$/.test(head)) throw Error('The saved private reflection head is invalid.');
  const bytes = storage.getItem(`${key}:${head}`);
  if (!bytes || await hash(bytes) !== head) throw Error('The saved private reflection failed its readback.');
  return { doc: await openReflection(bytes, person, item), head };
}

export async function saveReflection(storage, doc, expectedHead, lock) {
  if (typeof lock !== 'function') throw Error('Safe private reflection saving is unavailable in this browser.');
  validate(doc);
  return lock(keyFor(doc.person, doc.item), async () => {
    const key = keyFor(doc.person, doc.item);
    if (storage.getItem(key) !== expectedHead) throw Error('Another tab changed this reflection. Reload first.');
    const bytes = await sealReflection(doc), head = await hash(bytes), revision = `${key}:${head}`;
    const existing = storage.getItem(revision);
    if (existing !== null && existing !== bytes) throw Error('A saved private reflection conflicts.');
    storage.setItem(revision, bytes);
    const readback = storage.getItem(revision);
    if (readback !== bytes || JSON.stringify(await openReflection(readback, doc.person, doc.item)) !== JSON.stringify(doc)) {
      throw Error('Private reflection readback failed. Your notes are not saved.');
    }
    storage.setItem(key, head);
    if (storage.getItem(key) !== head) throw Error('Private reflection head readback failed. Your notes are not confirmed saved.');
    return { doc: structuredClone(doc), head };
  });
}

export function reflectionPrompts(record) {
  const links = rows => rows.length
    ? rows.map(row => `${row.label || 'Record link'}: ${row.url}`).join('\n')
    : 'No links are recorded here.';
  return {
    known: `What was known then?\n${links(record.known || [])}`,
    changed: `What has changed since?\n${(record.later || []).length ? links(record.changed || []) : 'No later annexes or results are recorded here.'}`,
    next: 'What would you want to know next time?',
  };
}

export function removeReflection(storage, person, item) {
  const key = keyFor(person, item), keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const candidate = storage.key(index);
    if (candidate === key || candidate?.startsWith(`${key}:`)) keys.push(candidate);
  }
  for (const candidate of keys) storage.removeItem(candidate);
  if (keys.some(candidate => storage.getItem(candidate) !== null)) throw Error('Private reflection could not be deleted.');
}

const node = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};
const addPrompt = (form, name, prompt, value) => {
  const label = node('label', prompt), input = node('textarea');
  input.name = name; input.maxLength = 4000; input.value = value; label.append(input); form.append(label);
};

export async function initReflection() {
  const root = document.getElementById('private-reflection');
  if (!root) return;
  let record;
  try { record = JSON.parse(root.dataset.record); }
  catch { return; }
  if (!record || typeof record.person !== 'string' || typeof record.item !== 'string') return;
  const lock = navigator.locks ? (name, action) => navigator.locks.request(name, action) : null;
  let saved, writing = Promise.resolve();
  const status = node('p'); status.setAttribute('role', 'status');
  const error = node('p'); error.setAttribute('role', 'alert'); error.className = 'error';
  const fail = problem => { error.textContent = `${problem.message} Keep this tab open and export your notes if possible.`; status.textContent = 'Not saved.'; };
  const persist = async doc => {
    const run = writing.then(async () => { saved = await saveReflection(localStorage, doc, saved.head, lock); error.textContent = ''; status.textContent = 'Saved on this device after an integrity readback.'; });
    writing = run.catch(() => {}); await run;
  };
  const render = () => {
    root.replaceChildren(node('h2', 'Private reflection on this device'));
    const toggle = node('label', 'Keep a private reflection in this browser');
    const enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = saved.doc.enabled; toggle.prepend(enabled); root.append(toggle, status, error);
    enabled.addEventListener('change', async () => {
      enabled.disabled = true;
      try {
        await persist({ ...saved.doc, enabled: enabled.checked, observed: enabled.checked ? record.changeKey : saved.doc.observed });
        render();
      } catch (problem) { fail(problem); enabled.checked = saved.doc.enabled; }
      finally { enabled.disabled = false; }
    });
    if (!saved.doc.enabled) { status.textContent = 'Off. Nothing from this reflection is sent to the server.'; return; }
    const prompts = reflectionPrompts(record);
    if (saved.doc.observed !== record.changeKey) {
      const card = node('section'); card.append(node('h3', 'Look back'), node('p', 'This record has later links or results. This is for you alone.'));
      const seen = node('button', 'I looked back');
      seen.addEventListener('click', async () => { seen.disabled = true; try { await persist({ ...saved.doc, observed: record.changeKey }); render(); } catch (problem) { fail(problem); } });
      card.append(seen); root.append(card);
    }
    const form = node('form');
    addPrompt(form, 'known', prompts.known, saved.doc.notes.known);
    addPrompt(form, 'changed', prompts.changed, saved.doc.notes.changed);
    addPrompt(form, 'next', prompts.next, saved.doc.notes.next);
    const save = node('button', 'Save on this device'); form.append(save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      try { const data = new FormData(form); await persist({ ...saved.doc, notes: Object.fromEntries(['known', 'changed', 'next'].map(name => [name, String(data.get(name) || '')])) }); }
      catch (problem) { fail(problem); } finally { save.disabled = false; }
    });
    root.append(form);
    const actions = node('p'), exportButton = node('button', 'Export private reflection'), deleteButton = node('button', 'Delete private reflection');
    exportButton.type = 'button'; deleteButton.type = 'button';
    exportButton.addEventListener('click', async () => {
      try { await writing; const bytes = await sealReflection(saved.doc); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' })); const link = node('a'); link.href = url; link.download = 'private-reflection.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }
      catch (problem) { fail(problem); }
    });
    deleteButton.type = 'button'; deleteButton.addEventListener('click', async () => {
      try { await writing; removeReflection(localStorage, record.person, record.item); saved = { doc: empty(record.person, record.item), head: null }; render(); status.textContent = 'Deleted from this browser.'; }
      catch (problem) { fail(problem); }
    });
    actions.append(exportButton, document.createTextNode(' '), deleteButton); root.append(actions);
  };
  try { saved = await loadReflection(localStorage, record.person, record.item); render(); }
  catch (problem) { root.replaceChildren(node('h2', 'Private reflection on this device'), error); fail(problem); }
}

if (typeof document !== 'undefined') initReflection();
