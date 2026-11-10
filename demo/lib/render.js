// Builds page pieces with createElement and text nodes only. Anything a visitor typed goes in
// as a text node, so it can never become markup. There is no innerHTML anywhere in the demo.
import { nameOf, people } from './roster.js';

const allowedAttrs = new Set(['class', 'id', 'type', 'name', 'value', 'for', 'href', 'rel', 'checked',
  'role', 'aria-live', 'aria-label', 'data-who', 'data-seq', 'maxlength', 'disabled']);

export function h(doc, tag, attrs = {}, ...children) {
  const el = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (!allowedAttrs.has(key)) throw new Error(`attribute not allowed: ${key}`);
    if (value === false || value === null || value === undefined) continue;
    el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'object' ? child : doc.createTextNode(String(child)));
  }
  return el;
}

export function renderWho(doc, root, current) {
  root.replaceChildren(...people.map(person => {
    const id = `who-${person.id}`;
    return h(doc, 'div', { class: 'who' },
      h(doc, 'input', { type: 'radio', name: 'who', id, value: person.id, 'data-who': person.id, checked: person.id === current }),
      h(doc, 'label', { for: id }, h(doc, 'strong', {}, person.name), ` ${person.note}`));
  }));
}

const pair = (doc, term, value) => [h(doc, 'dt', {}, term), h(doc, 'dd', {}, value)];

export function renderStatus(doc, root, view) {
  const rows = [
    ...pair(doc, 'Stage', `${view.stage} (${view.state})`),
    ...pair(doc, 'Steward', view.steward ? nameOf(view.steward) : 'nobody yet'),
    ...pair(doc, 'Approved by', view.approver ? nameOf(view.approver) : 'nobody yet'),
  ];
  if (view.approved) {
    rows.push(...pair(doc, 'Cap', `$${view.capUsd.toFixed(2)}`));
    rows.push(...pair(doc, 'Helps so far', `${view.helpers} of ${view.quorum} people`));
  }
  if (view.state === 'HELPS') rows.push(...pair(doc, 'Result', 'People who do this work said it helps.'));
  if (view.state === 'SHELVED') rows.push(...pair(doc, 'Result', 'Shelved. This item is over.'));
  if (view.artifactText) rows.push(...pair(doc, 'The try', view.artifactText));
  root.replaceChildren(h(doc, 'dl', { class: 'facts' }, rows));
}

export function renderResult(doc, root, result, actor) {
  if (!result) { root.replaceChildren(); return; }
  const who = nameOf(actor);
  if (result.status === 'note') {
    root.replaceChildren(h(doc, 'p', { class: 'note' }, result.message));
  } else if (result.status === 'invalid') {
    root.replaceChildren(h(doc, 'p', { class: 'note' }, 'Not sent. ', result.message));
  } else if (result.status === 'accepted') {
    root.replaceChildren(h(doc, 'p', { class: 'ok' }, h(doc, 'strong', {}, 'Accepted. '),
      `${who}'s step went through. The item is now ${result.state}.`));
  } else {
    root.replaceChildren(h(doc, 'div', { class: 'refused' },
      h(doc, 'p', {}, h(doc, 'strong', {}, 'Refused. '), `${who}'s step didn't go through. The log didn't change.`),
      h(doc, 'p', {}, h(doc, 'strong', {}, 'Rule: '), result.words),
      h(doc, 'p', { class: 'small' }, `What the code said: ${result.machine}. Rule name: ${result.rule}.`)));
  }
}

export function renderEvents(doc, root, rows) {
  if (!rows.length) { root.replaceChildren(h(doc, 'li', {}, 'Nothing yet.')); return; }
  root.replaceChildren(...rows.map(row => h(doc, 'li', {},
    h(doc, 'strong', {}, `${nameOf(row.actor)} `), `${row.type} `,
    h(doc, 'span', { class: 'hash' }, `${row.hash.slice(0, 12)} after ${row.prev ? row.prev.slice(0, 12) : 'the start'}`))));
}

export function renderRefusals(doc, root, refusals) {
  if (!refusals.length) { root.replaceChildren(h(doc, 'li', {}, 'None yet.')); return; }
  root.replaceChildren(...refusals.map(item => h(doc, 'li', {},
    h(doc, 'strong', {}, `${nameOf(item.who)} tried "${item.action}". `), item.words)));
}

export function renderTour(doc, root, played, total) {
  const items = played.map(entry => {
    const refused = entry.outcome.status === 'refused';
    const progress = entry.state.state === 'TRYING' && entry.state.approved
      ? `, ${entry.state.helpers} of ${entry.state.quorum} helpers` : '';
    return h(doc, 'li', { class: refused ? 'refused' : 'ok' },
      h(doc, 'strong', {}, `${nameOf(entry.step.who)}: ${entry.step.label}. `),
      h(doc, 'strong', {}, refused ? 'Refused. ' : 'Accepted. '),
      refused ? entry.outcome.words : entry.step.note,
      ` Item is ${entry.state.state}${progress}.`);
  });
  root.replaceChildren(...[h(doc, 'ol', {}, items),
    played.length === total
      ? h(doc, 'p', {}, "That's the whole rule. The item reached Helps only after two people who didn't shape it said so.")
      : null].filter(Boolean));
}
