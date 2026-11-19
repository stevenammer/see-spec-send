// Seed for the hosted demo: an invented roster and four invented stories, nothing else.
// Every name, place and story here is made up. Do not add a real person, employer, customer or product.
import { Store } from '../../core/store.js';
import { Ledger, fixturePolicy } from '../../gateway/ledger.js';

export const ROSTER = Object.freeze([
  { id: 'jose', leader: true },
  { id: 'omar', leader: true },
  { id: 'cleo', leader: false },
  { id: 'priya', leader: false },
  { id: 'wren', leader: false },
  { id: 'dara', leader: false },
]);

// Events are dated just before the seed moment so the feed reads as recent and never as the future.
export function seedDemo(file, { now = new Date() } = {}) {
  const store = new Store(file);
  try {
    new Ledger(store).configure(fixturePolicy());          // fixture gateway: tiny caps, no provider behind it
    for (const person of ROSTER) store.registerPerson(person.id, { leader: person.leader });
    const t0 = now.getTime() - 3 * 24 * 60 * 60 * 1000;
    let n = 0;
    const add = (item, event) => store.append(item, { ...event, at: new Date(t0 + (n++) * 7 * 60 * 1000).toISOString() }, { idem: `demo-${item}-${n}` });
    const bind = item => ({ post_id: store.read(item).context.activePost?.id, post_version: store.read(item).context.activePost?.version });
    const post = (item, actor, original) => { add(item, { type: 'posted', actor, rules: 3, audience: [], original }); return store.read(item).context.seeHash; };
    const spec = (item, actor, see, fields) => { add(item, { type: 'specced', actor, see_hash: see, ...fields, ...bind(item) }); return store.read(item).context.specHash; };

    // 1. Decided without a build: the existing thing was enough.
    let see = post('demo-label-shelf', 'cleo', 'At the Harbor Lantern bakery the morning crew cannot tell which tray is today\'s dough and which is yesterday\'s. Trays get mixed up about twice a week.');
    add('demo-label-shelf', { type: 'commented', actor: 'jose', kind: 'question', anchor_kind: 'see', anchor_hash: see, comment: 'Is it the trays that look alike, or the stickers that fall off?', ...bind('demo-label-shelf') });
    let sp = spec('demo-label-shelf', 'cleo', see, { must: ['Show which tray holds today\'s dough'], how_we_know: ['A new hire sorts ten trays correctly without asking'], out_of_scope: ['Changing how dough is mixed'], assumptions: ['Trays can carry a colored clip'], open_questions: ['Who buys the clips?'] });
    let packet = store.putArtifact('demo-label-shelf', JSON.stringify({ specHash: sp, invented: true }));
    add('demo-label-shelf', { type: 'sent', actor: 'cleo', spec_hash: sp, packet_hash: packet, ...bind('demo-label-shelf') });
    add('demo-label-shelf', { type: 'decided', actor: 'jose', disposition: 'resolve_without_build', reason_code: 'existing', reason: 'Colored clips cost almost nothing and need no software. Try them for two weeks first.', metadata: { alternative: 'Use one clip color per day.', action_owner: 'cleo' }, spec_hash: sp, packet_hash: packet, ...bind('demo-label-shelf') });

    // 2. Approved, built (a stand-in page), tried.
    see = post('demo-pickup-board', 'priya', 'Drivers at Juniper Freight Co-op ask the dispatcher the same three questions on every pickup: which dock, which door, who signs. Each call is about four minutes.');
    sp = spec('demo-pickup-board', 'priya', see, { must: ['A one-screen page that shows dock, door and signer for a pickup'], how_we_know: ['Calls to the dispatcher about these three questions drop for two weeks'], out_of_scope: ['Routing or scheduling'], assumptions: ['The dispatcher can enter the three fields'], open_questions: ['Who keeps the page current?'] });
    packet = store.putArtifact('demo-pickup-board', JSON.stringify({ specHash: sp, invented: true }));
    add('demo-pickup-board', { type: 'sent', actor: 'priya', spec_hash: sp, packet_hash: packet, ...bind('demo-pickup-board') });
    add('demo-pickup-board', { type: 'approved', actor: 'omar', spec_hash: sp, packet_hash: packet, reason: 'Small, reversible, and the measure is easy to check.', cap_usd: 0, quorum: 1, ...bind('demo-pickup-board') });
    store.registerToken('demo-run-pickup-board', { kind: 'run', item: 'demo-pickup-board' });
    const page = store.putArtifact('demo-pickup-board', '<!doctype html><title>Pickup board</title><p>Dock 4, door B, signer: front desk. (Invented demo page.)</p>');
    add('demo-pickup-board', { type: 'tried', actor: 'demo-run-pickup-board', approval: 1, spec_hash: sp, artifact_hash: page, iteration: 0 });

    // 3. Spec written, not yet sent.
    see = post('demo-quiet-hours', 'wren', 'The night nurses on the Larkspur wing get supply requests by pager all night, even when nothing is urgent. Several said they stop noticing the pager.');
    spec('demo-quiet-hours', 'wren', see, { must: ['Group non-urgent supply requests into one morning list'], how_we_know: ['Night pager count per shift drops by half over a month'], out_of_scope: ['Urgent clinical pages'], assumptions: ['Supply staff can read a list at 6 a.m.'], open_questions: ['What counts as urgent?'] });

    // 4. Just posted, one question, open for discussion.
    see = post('demo-ticket-names', 'dara', 'Support agents at Copperfield Music Supply name the same kind of ticket five different ways, so the weekly count of broken-string complaints is never right.');
    add('demo-ticket-names', { type: 'commented', actor: 'omar', kind: 'question', anchor_kind: 'see', anchor_hash: see, comment: 'Could we pick one name first and see if the count fixes itself?', ...bind('demo-ticket-names') });
    return { people: ROSTER.length, items: 4 };
  } finally { store.close(); }
}
