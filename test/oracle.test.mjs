import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../core/store.js';

const states = ['SEEN', 'CHECKED', 'SPECCED', 'SENDING', 'TRYING', 'HELPS', 'SHELVED'];
const kinds = ['member', 'leader', 'steward', 'approver', 'gateway', 'run', 'stranger'];

function table() {
  const lines = readFileSync('core/MACHINE.md', 'utf8').split('\n');
  return lines.filter(line => /^\| (?:SEEN|CHECKED|SPECCED|SENDING|TRYING|open) \|/.test(line))
    .map(line => line.split('|').map(part => part.trim()).slice(1, -1))
    .flatMap(([from, type, role]) => (from === 'open'
      ? ['SEEN', 'CHECKED', 'SPECCED', 'SENDING', 'TRYING'].map(state => [state, type, role])
      : [[from, type, role]]));
}

function allowed(rows, state, type, kind) {
  return rows.some(([from, event, role]) => from === state && event === type && (
    (role === 'member' && ['member', 'leader', 'steward', 'approver'].includes(kind))
    || (role.startsWith('member, neither') && ['member', 'leader'].includes(kind))
    || (role.startsWith('leader') && ['leader', 'approver'].includes(kind))
    || (role === 'steward' && kind === 'steward')
    || (role === 'leader or steward' && (kind === 'leader' || (kind === 'steward' && state !== 'SEEN')))
    || (role === 'gateway' && kind === 'gateway')
    || (role === 'run' && kind === 'run')
  ));
}

function setup(state) {
  const store = new Store(); const item = 'i';
  for (const id of ['member', 'steward', 'helper']) store.registerPerson(id);
  store.registerPerson('leader', { leader: true }); store.registerPerson('approver', { leader: true });
  store.registerToken('gateway', { kind: 'gateway', item }); store.registerToken('run', { kind: 'run', item });
  const put = (type, actor, body, idem) => store.append(item, { type, actor, at: `2026-11-09T00:00:${idem}.000Z`, ...body }, { idem });
  if (state !== 'SEEN') put('checked', 'steward', { problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' }, '1');
  if (['SPECCED', 'SENDING', 'TRYING', 'HELPS'].includes(state)) put('specced', 'steward', { must: ['x'], how_we_know: ['x'], out_of_scope: [] }, '2');
  if (['SENDING', 'TRYING', 'HELPS'].includes(state)) put('approved', 'approver', { spec_hash: store.events(item).at(-1).body_hash, cap_usd: 1, quorum: 1 }, '3');
  if (['TRYING', 'HELPS'].includes(state)) put('tried', 'run', { artifact_hash: 'a', approval: 1, spec_hash: store.read(item).context.specHash }, '4');
  if (state === 'HELPS') put('helped', 'member', { artifact_hash: 'a' }, '5');
  if (state === 'SHELVED') put('shelved', 'leader', { reason: 'x' }, '6');
  return { store, item, put };
}

function body(type, store, item) {
  const spec = store.events(item).find(event => event.type === 'specced')?.body_hash || 'none';
  const context = store.read(item).context;
  return {
    checked: { problem: 'x', looked: ['x'], found: [], verdict: 'build_needed' },
    specced: { must: ['x'], how_we_know: ['x'], out_of_scope: [] },
    approved: { spec_hash: spec, cap_usd: 1, quorum: 1 }, returned: { note: 'x' },
    charged: { usd: 0, approval: context.approval, spec_hash: context.specHash },
    tried: { artifact_hash: 'a', approval: context.approval, spec_hash: context.specHash },
    failed: { approval: context.approval, spec_hash: context.specHash },
    helped: { artifact_hash: 'a' }, shelved: { reason: 'x' }, commented: context.specHash ? { comment: 'x', anchor_kind: 'spec', anchor_hash: context.specHash } : { comment: 'x' },
    checked_in: { note: 'x' },
    steward_changed: { steward: 'member' }, erased: { body_hash: spec },
  }[type];
}

test('the parsed machine table is the real store oracle', () => {
  const rows = table();
  assert.ok(rows.length >= 16, 'machine table parsed');
  const events = [...new Set(rows.map(row => row[1]))];
  for (const state of states) for (const type of events) for (const kind of kinds) {
    const { store, item } = setup(state);
    const actor = kind === 'stranger' ? 'stranger' : kind;
    const shouldAccept = allowed(rows, state, type, kind);
    let accepted = true;
    try { store.append(item, { type, actor, at: '2026-11-09T09:09:09.000Z', ...body(type, store, item) }, { idem: `${state}:${type}:${kind}` }); }
    catch { accepted = false; }
    assert.equal(accepted, shouldAccept, `${state} ${type} ${kind}`);
  }
});
