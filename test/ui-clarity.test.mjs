import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { feedPage, itemPage, newItemPage, passwordPage, redeemPage, signInPage } from '../app/pages.js';
import { specPage } from '../app/pages-spec.js';
import { adminRefusedPage } from '../app/pages-admin.js';

// Findings from walking the app cold as a first-time user (Nov 17, 2026), pinned so they are not quietly undone.
const at = n => `2026-11-17T00:00:${String(n).padStart(2, '0')}.000Z`;
const append = (store, event, n) => store.append('i', { ...event, at: at(n) }, { idem: `ui-${n}` });
function world(stage) {
  const store = new Store();
  for (const id of ['maya', 'ben']) store.registerPerson(id); store.registerPerson('lena', { leader: true });
  append(store, { type: 'posted', actor: 'maya', original: 'We copy every refund into a spreadsheet by hand.', rules: 2 }, 1);
  const see = store.read('i').context.seeHash;
  if (stage !== 'see') append(store, { type: 'specced', actor: 'maya', see_hash: see, must: ['Show each refund once'], how_we_know: ['Nobody opens the spreadsheet'], out_of_scope: [] }, 2);
  const spec = store.read('i').context.specHash;
  if (stage === 'sent' || stage === 'approved') { const packet = store.putArtifact('i', JSON.stringify({ specHash: spec })); append(store, { type: 'sent', actor: 'maya', spec_hash: spec, packet_hash: packet }, 3);
    if (stage === 'approved') append(store, { type: 'approved', actor: 'lena', spec_hash: spec, packet_hash: packet, reason: 'A leader recorded a real reason.', cap_usd: 1, quorum: 1 }, 4); }
  const item = { id: 'i', ...store.read('i'), effort: [], effortAllowance: { day: '2026-11-17', enabled: true, mention_requests_person: 10, mention_requests_item: 30, on_demand_person: 10, on_demand_item: 30, automatic_person: 50, automatic_item: 2, person_micros: 100000, day_micros: 100000, global_micros: 1000000 } };
  return { store, item, events: store.events('i') };
}
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('a stranger on the sign-in page is told what this is, and sees no links that lead nowhere', () => {
  const page = signInPage();
  assert.match(text(page), /way for a team to fix the problems everyone already knows about/);
  assert.match(text(page), /Nothing counts as done until the people who do the work say it helped/);
  assert.doesNotMatch(page, /href="\/search"|href="\/intelligence"|href="\/mentoring"/);
  assert.match(page, /href="\/redeem"/);
  const redeem = redeemPage();
  assert.match(text(redeem), /An invite comes from someone who runs this workspace/); assert.match(redeem, /href="\/signin"/); assert.match(redeem, /minlength="12"/);
  assert.doesNotMatch(redeem, /href="\/search"/);
  assert.match(text(passwordPage()), /The password you were given was temporary/);
});

test('posting a problem tells you what to write, and to check what you already have first', () => {
  const page = text(newItemPage());
  assert.match(page, /A SEE is the problem as you saw it/); assert.match(page, /If you already checked whether something you have \(a setting, a tool you pay for, a free one\) solves it, say that too/); assert.match(page, /oh, it already does that/);
  assert.match(newItemPage(), /placeholder="Example: We copy every refund/);
});

test('every stage gives the person looking at it one plain next step', () => {
  const see = world('see'); const asAuthor = text(itemPage(see.item, see.events, 'maya', false)), asOther = text(itemPage(see.item, see.events, 'ben', false));
  assert.match(asAuthor, /Next: let people talk it over in the thread below\. When the problem is clear, write the spec/);
  assert.match(asOther, /Next: add what you know in the thread below\. To ask Effort \(the AI\) a question, write @effort/);
  const spec = world('spec');
  assert.match(text(itemPage(spec.item, spec.events, 'maya', false)), /Your spec is written\. Next: open it and press SEND IT!/);
  assert.match(text(itemPage(spec.item, spec.events, 'ben', false)), /A spec has been written\./);
  const sent = world('sent');
  assert.match(text(itemPage(sent.item, sent.events, 'lena', true)), /This is waiting for a leader's decision\. You can approve it with a budget/);
  assert.match(text(itemPage(sent.item, sent.events, 'ben', false)), /Waiting for a leader's decision\. A leader who didn't write the spec will approve it/);
  assert.match(itemPage(sent.item, sent.events, 'lena', true), /<section id="decision">/);
  const approved = world('approved');
  assert.match(text(itemPage(approved.item, approved.events, 'maya', false)), /Approved\. A small version is being built/);
  for (const state of ['TRYING', 'HELPS', 'SHELVED']) assert.match(text(itemPage({ ...approved.item, state }, approved.events, 'ben', false)), /Next|A try is ready|People who do the work said it helps|This was shelved/, state);
});

test('the item page leads with the problem and the conversation, and keeps the machinery out of the way', () => {
  const { item, events } = world('see'); const page = itemPage(item, events, 'maya', false);
  assert.ok(page.indexOf('class="next"') < page.indexOf('<h2>Thread</h2>'), 'the next step comes first');
  assert.ok(page.indexOf('<h2>Thread</h2>') < page.indexOf('<h2>Write the spec</h2>'), 'the conversation comes before the spec form');
  assert.match(page, /<details><summary>AI usage and limits for this item<\/summary><section><h2>Effort allowance remaining<\/h2>/, 'internal accounting is collapsed');
  assert.match(page, /<details><summary>Original post, versions and record<\/summary>/);
  assert.doesNotMatch(page, /people have said it helps/, 'no helps counter before anything is delivered');
  assert.doesNotMatch(page, /Fork a frozen stage/, 'no empty frozen-stage form on a fresh item');
  assert.match(page, /No comments yet\. Add what you know, or ask a question\./);
  assert.match(page, /id="write-spec"/);
  assert.match(page, /Advanced: data sources and audiences/);
  assert.doesNotMatch(text(page), /see_first|frozen at event/);
});

test('the helps counter appears once a try is out, and the feed says in plain words where each problem stands', () => {
  const trying = world('approved'); trying.item.state = 'TRYING';
  assert.match(text(itemPage(trying.item, trying.events, 'ben', false)), /0 of 1 people have said it helps/);
  const feed = feedPage([{ id: 'a', state: 'SEEN', problem: 'One', helpers: 0, quorum: 2 }, { id: 'b', state: 'SPECCED', problem: 'Two', helpers: 0, quorum: 2 }, { id: 'c', state: 'SUBMITTED', problem: 'Three', helpers: 0, quorum: 2 }, { id: 'd', state: 'TRYING', problem: 'Four', helpers: 1, quorum: 2 }]);
  for (const phrase of ['Open for discussion', 'Spec written, not yet sent for a decision', "Waiting for a leader's decision", '1 of 2 people have said it helps']) assert.ok(feed.includes(phrase), phrase);
  assert.match(text(feed), /A Vision Quest is a short set of guided questions/);
});

test('the spec page says what happens next, and the approval form explains its limits', () => {
  const spec = world('spec');
  assert.match(text(specPage(spec.item, spec.events, 'maya')), /Next: read it once more\. When it says what you want, press SEND IT! below/);
  assert.match(text(specPage(spec.item, spec.events, 'ben')), /This spec is not sent yet/);
  const sent = world('sent');
  const sentPage = specPage(sent.item, sent.events, 'maya');
  assert.match(text(sentPage), /Sent\. A leader who didn't write it decides/); assert.match(sentPage, /href="\/items\/i#decision"/);
  assert.match(sentPage, /<details><summary>AI usage and limits for this item<\/summary>/);
  const leaderPage = itemPage(sent.item, sent.events, 'lena', true);
  for (const hint of ['The most the AI may spend building this', 'They must be people other than the one who wrote the spec and you', 'How long this approval stays open']) assert.ok(text(leaderPage).includes(hint), hint);
});

test('a member who opens the administration page gets an explanation, not raw JSON', () => {
  const page = adminRefusedPage();
  assert.match(text(page), /This page is for leaders\. If you think you should have access, ask the person who runs this workspace/);
  assert.doesNotMatch(page, /"error"/);
});

test('on a current-style item, the frozen-stage form and the plain stage history appear only once something is frozen', () => {
  const store = new Store(); store.registerPerson('maya');
  store.append('r3', { type: 'posted', actor: 'maya', original: 'A current-style problem.', rules: 3, at: at(1) }, { idem: 'r3-1' });
  const base = { id: 'r3', ...store.read('r3'), effort: [], effortAllowance: null };
  const fresh = itemPage({ ...base, stagePosts: [{ kind: 'see', post_id: 'p1', closed_seq: null, snapshot_hash: null }] }, store.events('r3'), 'maya', false);
  assert.doesNotMatch(fresh, /Fork a frozen stage/); assert.match(text(fresh), /SEE: in progress/);
  const frozen = itemPage({ ...base, stagePosts: [{ kind: 'see', post_id: 'p1', closed_seq: 3, snapshot_hash: 'a'.repeat(64) }, { kind: 'spec', post_id: 'p2', closed_seq: null, snapshot_hash: null }] }, store.events('r3'), 'maya', false);
  assert.match(frozen, /Fork a frozen stage/); assert.match(text(frozen), /SEE\s*: locked at step 3; a closing report is being prepared/); assert.match(text(frozen), /SPEC: in progress/);
  assert.doesNotMatch(text(frozen), /a{64}/, 'the hash is not shown in the stage line');
});
