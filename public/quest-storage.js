import { emptyQuest, validateQuest } from './vision-quest.js';

const FORMAT = 'see-spec-send/quest-v1';
const keyFor = person => `sss-quest:${encodeURIComponent(person)}`;
const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(text),
)), byte => byte.toString(16).padStart(2, '0')).join('');

export async function sealQuest(doc) {
  validateQuest(doc);
  return JSON.stringify({ format: FORMAT, sha256: await hash(JSON.stringify(doc)), data: doc });
}

export async function openQuest(text, person) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 125000) {
    throw Error('Invalid quest file.');
  }
  const envelope = JSON.parse(text);
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'data,format,sha256' ||
      envelope.format !== FORMAT || typeof envelope.sha256 !== 'string' ||
      envelope.sha256 !== await hash(JSON.stringify(envelope.data))) {
    throw Error('The quest file failed its integrity check.');
  }
  validateQuest(envelope.data, person);
  return structuredClone(envelope.data);
}

export async function loadDraft(storage, person) {
  const key = keyFor(person);
  const head = storage.getItem(key);
  if (head === null) return { doc: emptyQuest(person), head: null };
  if (!/^[a-f0-9]{64}$/.test(head)) throw Error('The saved draft head is invalid.');
  const bytes = storage.getItem(`${key}:${head}`);
  if (!bytes || await hash(bytes) !== head) throw Error('The saved draft failed its readback.');
  return { doc: await openQuest(bytes, person), head };
}

export async function saveDraft(storage, doc, expectedHead, lock, { restore = false, restart = false } = {}) {
  if (typeof lock !== 'function') throw Error('Safe draft saving is unavailable in this browser.');
  validateQuest(doc);
  return lock(keyFor(doc.person), async () => {
    const observed = storage.getItem(keyFor(doc.person));
    if (observed !== expectedHead) throw Error('Another tab changed this draft. Reload first.');
    let previous;
    try { previous = await loadDraft(storage, doc.person); }
    catch (error) {
      if (!restore) throw error;
      // Recovery retains corrupt bytes before replacing only the active pointer.
      const backupKey = `${keyFor(doc.person)}:recovery:${await hash(String(observed))}`;
      storage.setItem(backupKey, String(observed));
      if (storage.getItem(backupKey) !== String(observed)) throw Error('Recovery readback failed.');
      previous = { doc: emptyQuest(doc.person), head: observed };
    }
    if (restart) {
      if (doc.turns.length || doc.pending || !doc.questId) throw Error('Invalid new quest.');
      const history = questHistory(storage, doc.person);
      if (previous.head && !history.includes(previous.head)) {
        const key = `${keyFor(doc.person)}:history`;
        const bytes = JSON.stringify([...history, previous.head]);
        storage.setItem(key, bytes);
        if (storage.getItem(key) !== bytes) throw Error('Quest history readback failed.');
      }
    }
    if (!restore && !restart && (doc.turns.length < previous.doc.turns.length ||
        JSON.stringify(doc.turns.slice(0, previous.doc.turns.length)) !==
          JSON.stringify(previous.doc.turns))) {
      throw Error('Corrections must keep the original turns.');
    }
    const bytes = await sealQuest(doc);
    const head = await hash(bytes);
    const revisionKey = `${keyFor(doc.person)}:${head}`;
    // Immutable revisions retain prior durable bytes, even when a later head write fails.
    const existing = storage.getItem(revisionKey);
    if (existing !== null && existing !== bytes) throw Error('A saved revision conflicts.');
    storage.setItem(revisionKey, bytes);
    const readback = storage.getItem(revisionKey);
    if (readback !== bytes || JSON.stringify(await openQuest(readback, doc.person)) !==
        JSON.stringify(doc)) throw Error('Draft readback failed. Your answer is not saved.');
    storage.setItem(keyFor(doc.person), head);
    if (storage.getItem(keyFor(doc.person)) !== head) {
      throw Error('Draft head readback failed. Your answer is not confirmed saved.');
    }
    return { doc: structuredClone(doc), head };
  });
}

export async function restoreDraft(storage, text, person, expectedHead, lock) {
  // Validate all imported bytes before any write; a checksum is not proof of truth.
  const doc = await openQuest(text, person);
  return saveDraft(storage, doc, expectedHead, lock, { restore: true });
}

const pendingKey = (person, tab) => `${keyFor(person)}:unsent:${encodeURIComponent(tab)}`;
export function savePending(storage, person, tab, head, pending) {
  validateQuest({ ...emptyQuest(person), pending });
  const bytes = JSON.stringify({ version: 1, person, head, pending });
  if (new TextEncoder().encode(bytes).byteLength > 30000) {
    throw Error('Unsent input is too large to recover safely.');
  }
  const key = pendingKey(person, tab);
  // This synchronous, bounded recovery slot survives immediate reload during typing.
  // It is uncommitted input, not a SHA-verified submitted turn.
  storage.setItem(key, bytes);
  if (storage.getItem(key) !== bytes) throw Error('Unsent input readback failed.');
}

export function loadPending(storage, person, tab, head) {
  const bytes = storage.getItem(pendingKey(person, tab));
  if (bytes === null) return null;
  if (new TextEncoder().encode(bytes).byteLength > 30000) throw Error('Invalid unsent input recovery.');
  const data = JSON.parse(bytes);
  if (!data || Object.keys(data).sort().join(',') !== 'head,pending,person,version' ||
      data.version !== 1 || data.person !== person) throw Error('Invalid unsent input recovery.');
  validateQuest({ ...emptyQuest(person), pending: data.pending });
  // A stale tab's unsent work must never overwrite newer submitted answers.
  if (data.head !== head) {
    const error = Error('Unsent input belongs to an older draft. Export it before reconciling.');
    error.recovery = data;
    throw error;
  }
  return data.pending;
}

export function clearPending(storage, person, tab) {
  const key = pendingKey(person, tab);
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw Error('Unsent input could not be cleared.');
}

export function readDraftHead(storage, person) {
  return storage.getItem(keyFor(person));
}


export async function loadRevision(storage, person, head) {
  if (head === null) return emptyQuest(person);
  if (!/^[a-f0-9]{64}$/.test(head)) throw Error('Invalid recovery revision.');
  const bytes = storage.getItem(`${keyFor(person)}:${head}`);
  if (!bytes || await hash(bytes) !== head) throw Error('The recovery revision is unavailable.');
  return openQuest(bytes, person);
}

export function archivePending(storage, person, tab, recovery) {
  const key = `${pendingKey(person, tab)}:archive`;
  const bytes = JSON.stringify(recovery);
  if (new TextEncoder().encode(bytes).byteLength > 30000) throw Error('Recovery is too large.');
  const previous = storage.getItem(key);
  if (previous !== null && previous !== bytes) {
    throw Error('Export and discard the earlier recovery before changing this draft.');
  }
  storage.setItem(key, bytes);
  if (storage.getItem(key) !== bytes) throw Error('Older recovery readback failed.');
}

export function loadArchivedPending(storage, person, tab) {
  const bytes = storage.getItem(`${pendingKey(person, tab)}:archive`);
  if (bytes === null) return null;
  if (new TextEncoder().encode(bytes).byteLength > 30000) throw Error('Invalid older recovery.');
  const data = JSON.parse(bytes);
  if (!data || Object.keys(data).sort().join(',') !== 'head,pending,person,version' ||
      data.version !== 1 || data.person !== person) throw Error('Invalid older recovery.');
  validateQuest({ ...emptyQuest(person), pending: data.pending });
  return data;
}

export function discardArchivedPending(storage, person, tab) {
  const key = `${pendingKey(person, tab)}:archive`;
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw Error('Older recovery could not be discarded.');
}


export function questHistory(storage, person) {
  const bytes = storage.getItem(`${keyFor(person)}:history`);
  const heads = bytes === null ? [] : JSON.parse(bytes);
  if (!Array.isArray(heads) || heads.some(head => !/^[a-f0-9]{64}$/.test(head))) {
    throw Error('Quest history is damaged. Export before changing it.');
  }
  return heads;
}

export async function startAnotherQuest(storage, person, expectedHead, lock) {
  const doc = { ...emptyQuest(person), questId: crypto.randomUUID() };
  return saveDraft(storage, doc, expectedHead, lock, { restart: true });
}

const receiptKey = (person, head) => {
  if (!/^[a-f0-9]{64}$/.test(head)) throw Error('Save the quest before posting.');
  return `${keyFor(person)}:posted:${head}`;
};
export function postedQuestItem(storage, person, head) {
  if (head === null) return null;
  const item = storage.getItem(receiptKey(person, head));
  if (item !== null && !/^[a-zA-Z0-9_-]{1,100}$/.test(item)) throw Error('Invalid posted quest receipt.');
  return item;
}
export function markQuestPosted(storage, person, head, item) {
  if (typeof item !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item)) throw Error('Invalid posted item.');
  const key = receiptKey(person, head);
  const prior = postedQuestItem(storage, person, head);
  if (prior !== null && prior !== item) throw Error('Posted quest receipt conflicts.');
  storage.setItem(key, item);
  if (storage.getItem(key) !== item) throw Error('Posted receipt readback failed. Retry safely from this draft.');
}
