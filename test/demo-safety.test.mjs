import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createLog } from '../demo/lib/log.js';
import { createSession, perform, summary, limits, parseCap, parseQuorum, parseLines } from '../demo/lib/flow.js';
import { makeRoster, item, people } from '../demo/lib/roster.js';
import { h, renderEvents, renderRefusals, renderResult, renderStatus, renderTour, renderWho } from '../demo/lib/render.js';
import { playAll } from '../demo/lib/tour.js';
import { Node, fakeDocument, walk, textOf } from './demo-fakedom.mjs';

const read = path => readFileSync(new URL(`../demo/${path}`, import.meta.url), 'utf8');
const files = ['index.html', 'style.css', 'app.js', ...readdirSync(new URL('../demo/lib/', import.meta.url)).map(name => `lib/${name}`)];
const own = files.filter(name => name !== 'lib/machine.js');
const fresh = () => createSession({ log: createLog({ roster: makeRoster(), item }), roster: makeRoster() });
const payloads = [
  '<script>window.hit=1</script>', '"><img src=x onerror=alert(1)>', "' onfocus='alert(1)' x='",
  '<svg/onload=alert(1)>', 'javascript:alert(1)', '${alert(1)}', '</textarea><b>bold</b>',
];

test('index.html: strict CSP in a meta tag, no inline script or style, no inline handlers', () => {
  const html = read('index.html');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(csp, 'CSP meta tag is present');
  const parts = Object.fromEntries(csp.split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(parts['default-src'], ["'none'"]);
  assert.deepEqual(parts['connect-src'], ["'none'"]);
  assert.deepEqual(parts['script-src'], ["'self'"]);
  assert.deepEqual(parts['style-src'], ["'self'"]);
  assert.deepEqual(parts['form-action'], ["'none'"]);
  assert.deepEqual(parts['base-uri'], ["'none'"]);
  assert.doesNotMatch(csp, /unsafe-|https?:|\*|data:/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handler attributes');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no inline styles');
  for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []) {
    assert.match(tag, /src="app\.js"/);
    assert.match(tag.replace(/<script\b[^>]*>/, '').replace('</script>', ''), /^\s*$/, 'script tags have no inline code');
  }
  assert.equal([...html.matchAll(/<form\b[^>]*>/g)].filter(([tag]) => /\saction=/.test(tag)).length, 0);
});

test('the page links to nothing outside itself except the repository, and loads nothing remote', () => {
  const html = read('index.html');
  const urls = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]);
  for (const url of urls) {
    if (/^https?:/.test(url)) assert.match(url, /^https:\/\/github\.com\/stevenammer\/see-spec-send(\/|$)/, url);
  }
  for (const [, tag, attrs] of html.matchAll(/<(link|img|iframe|script|source|video|audio|object|embed)\b([^>]*)>/g)) {
    const url = attrs.match(/(?:href|src)="([^"]+)"/)?.[1];
    if (url) assert.doesNotMatch(url, /^(https?:)?\/\//, `${tag} loads a remote file`);
  }
  assert.doesNotMatch(read('style.css'), /@import|url\(/);
});

test('no network, eval, cookies, or HTML injection APIs in the demo code', () => {
  const banned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|eval|Function|document\.write|innerHTML|outerHTML|insertAdjacentHTML|srcdoc|document\.cookie|sessionStorage|indexedDB|serviceWorker)\b|\bimport\s*\(|setTimeout\s*\(\s*['"`]|on[a-z]+\s*=\s*function/;
  for (const name of own.filter(entry => entry.endsWith('.js'))) {
    const code = read(name).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, banned, `${name} uses a banned API`);
  }
  // localStorage is allowed only in app.js, behind the visitor's checkbox.
  for (const name of own.filter(entry => entry.endsWith('.js') && entry !== 'app.js')) {
    assert.doesNotMatch(read(name), /localStorage/, name);
  }
});

test('no em or en dashes in anything the demo ships', () => {
  for (const name of files) assert.doesNotMatch(read(name), /[–—]/, name);
});

test('look: no orange, no italics, system fonts only', () => {
  const css = read('style.css');
  assert.doesNotMatch(css, /italic|oblique|orange|@font-face/i);
  assert.match(css, /font:[^;]*system-ui/);
  for (const [, hex] of css.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b); const min = Math.min(r, g, b);
    if (max === min) continue;
    let hue = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
    hue = (hue * 60 + 360) % 360;
    const saturation = (max - min) / (1 - Math.abs(max + min - 1));
    assert.ok(!(hue >= 15 && hue <= 50 && saturation > 0.4 && max > 0.4), `#${hex} reads as orange`);
  }
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(read('index.html'), /name="viewport" content="width=device-width,initial-scale=1"/);
});

test('contrast: text and button colors reach WCAG AA', () => {
  const lum = hex => {
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const pairs = [['17212b', 'ffffff'], ['064f9e', 'ffffff'], ['ffffff', '075b9c'], ['4d0d14', 'fbe9ea'], ['17212b', 'd9f4e4'],
    ['3a4754', 'ffffff'], ['4a5866', 'eef1f4'], ['17212b', 'eef1f4']];
  for (const [fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg} is ${ratio(fg, bg).toFixed(2)}`);
});

test('render: hostile text becomes text nodes, never elements or attributes', async () => {
  const session = fresh();
  const tags = new Set(); const attrNames = new Set();
  const scan = node => walk(node, entry => { tags.add(entry.tag); Object.keys(entry.attrs).forEach(name => attrNames.add(name)); });
  const root = () => new Node('div');
  for (const payload of payloads) {
    const sent = await perform(session, 'maya', 'post', { problem: payload, verdict: 'build_needed', checks: { have: { on: true, note: payload } } });
    assert.equal(sent.status, 'accepted');
    await perform(session, 'maya', 'spec', { must: payload, how_we_know: payload, out_of_scope: payload });
    await perform(session, 'lena', 'approve', { cap: payload, quorum: payload });
    await perform(session, 'maya', 'shelve', { reason: payload });
    await perform(session, 'lena', 'shelve', { reason: payload });
    const rendered = [root(), root(), root(), root(), root()];
    renderStatus(fakeDocument, rendered[0], summary(session));
    renderEvents(fakeDocument, rendered[1], session.log.rows());
    renderRefusals(fakeDocument, rendered[2], session.refusals);
    renderResult(fakeDocument, rendered[3], { status: 'refused', words: payload, machine: payload, rule: payload }, 'maya');
    renderResult(fakeDocument, rendered[3], { status: 'invalid', message: payload }, 'maya');
    renderWho(fakeDocument, rendered[4], 'maya');
    rendered.forEach(scan);
    session.log = createLog({ roster: makeRoster(), item });
  }
  const allowed = new Set(['div', '#text', 'dl', 'dt', 'dd', 'li', 'strong', 'span', 'p', 'input', 'label', 'ol']);
  assert.deepEqual([...tags].filter(tag => !allowed.has(tag)), []);
  assert.deepEqual([...attrNames].filter(name => /^on|style|srcdoc|src$/i.test(name)), []);
  const play = await playAll(fresh());
  const tour = root(); renderTour(fakeDocument, tour, play, play.length);
  const text = textOf(tour);
  assert.match(text, /Helps/);
  // The hostile problem text shows up as plain text where it was typed.
  const status = root();
  const hostile = fresh();
  await perform(hostile, 'maya', 'post', { problem: payloads[0], verdict: 'build_needed', checks: { have: { on: true, note: 'n' } } });
  await perform(hostile, 'maya', 'spec', { must: payloads[1], how_we_know: payloads[2] });
  await perform(hostile, 'lena', 'approve', { cap: '1', quorum: '1' });
  await perform(hostile, 'maya', 'deliver', { text: payloads[0] });
  renderStatus(fakeDocument, status, summary(hostile));
  assert.ok(textOf(status).includes(payloads[0]));
  const nodes = []; walk(status, node => nodes.push(node.tag));
  assert.ok(!nodes.includes('script') && !nodes.includes('img'));
});

test('render: the element builder refuses event-handler and unknown attributes', () => {
  for (const name of ['onclick', 'onerror', 'style', 'src', 'srcdoc', 'formaction']) {
    assert.throws(() => h(fakeDocument, 'div', { [name]: 'x' }), /attribute not allowed/);
  }
  assert.equal(h(fakeDocument, 'p', {}, '<b>x</b>').children[0].tag, '#text');
});

test('input is bounded: long or odd input is refused before it reaches the log', async () => {
  const session = fresh();
  const checks = { have: { on: true, note: 'x'.repeat(5000) } };
  const long = await perform(session, 'maya', 'post', { problem: 'a'.repeat(limits.problem + 1), verdict: 'build_needed', checks });
  assert.equal(long.status, 'invalid');
  assert.equal(session.log.length, 0);
  assert.equal((await perform(session, 'maya', 'post', { problem: 'ok', verdict: 'bogus', checks })).status, 'invalid');
  assert.equal((await perform(session, 'maya', 'post', { problem: 'ok', verdict: 'free', checks: {} })).status, 'invalid');
  assert.equal(session.log.length, 0);
  // A long note is cut to its limit, as the real server does.
  assert.equal((await perform(session, 'maya', 'post', { problem: 'ok', verdict: 'free', checks })).status, 'accepted');
  assert.equal(session.log.events()[0].looked[0].length, 'have:'.length + limits.note);
  assert.equal(parseLines('a\n'.repeat(limits.lines + 1), { name: 'x' }).error !== undefined, true);
  assert.equal(parseLines('x'.repeat(limits.line + 1), { name: 'x' }).error !== undefined, true);
  for (const bad of ['', '-1', '1e3', '1.234', '10000', ' ', '0x10', 'NaN', '5; drop']) assert.ok(parseCap(bad).error, bad);
  for (const good of ['0', '5', '2.50', '9999.99']) assert.equal(parseCap(good).value, Number(good));
  for (const bad of ['0', '7', '-1', '1.5', 'x', '']) assert.ok(parseQuorum(bad).error, bad);
  assert.equal((await perform(session, 'maya', 'deliver', { text: 'x'.repeat(limits.text + 1) })).status, 'invalid');
});

test('the roster is invented, fixed, and has leaders and members', () => {
  assert.deepEqual(people.map(person => person.name), ['Maya', 'Lena', 'Ben', 'Cleo', 'Omar', 'Priya']);
  assert.deepEqual(people.filter(person => person.leader).map(person => person.id), ['lena', 'omar']);
  const roster = makeRoster();
  assert.throws(() => { roster.ben.leader = true; }, TypeError);
  assert.throws(() => { roster.eve = { kind: 'person', leader: true }; }, TypeError);
});

test('delivering a try is limited to the steward or a leader, in the web layer', async () => {
  const session = fresh();
  await perform(session, 'maya', 'post', { problem: 'p', verdict: 'build_needed', checks: { have: { on: true, note: '' } } });
  await perform(session, 'maya', 'spec', { must: 'a', how_we_know: 'b' });
  const early = await perform(session, 'maya', 'deliver', { text: 'try' });
  assert.equal(early.rule, 'deliver-who');
  await perform(session, 'lena', 'approve', { cap: '1', quorum: '1' });
  assert.equal((await perform(session, 'ben', 'deliver', { text: 'try' })).status, 'refused');
  assert.equal((await perform(session, 'lena', 'deliver', { text: 'try' })).status, 'accepted');
  assert.equal(summary(session).state, 'TRYING');
});

test('the workflow file publishes only demo/, pins every action to a commit, and needs no secrets', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  for (const [, ref] of workflow.matchAll(/uses:\s*(\S+)/g)) assert.match(ref, /@[0-9a-f]{40}$/, ref);
  assert.match(workflow, /branches:\s*\[\s*main\s*\]|branches:\n\s*- main/);
  assert.match(workflow, /path:\s*demo/);
  assert.match(workflow, /npm run check:demo/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /pull_request/);
});
