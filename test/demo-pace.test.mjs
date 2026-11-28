// "Watch it play out" must be slow enough to read (Nov 27 2026: the first version gave each step 2.4 seconds,
// and people with reduced motion got a quarter second).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AFTER_REFUSAL_MS, AFTER_STEP_MS, readMs, storyMs } from '../demo/lib/pace.js';
import { story } from '../demo/lib/story.js';

test('every caption gets at least 200-words-a-minute reading time, within 3 to 8 seconds', () => {
  for (const step of story) {
    const words = step.say.trim().split(/\s+/).length;
    assert.ok(readMs(step.say) >= Math.min(8000, words * 300), step.say);
    assert.ok(readMs(step.say) >= 3000 && readMs(step.say) <= 8000);
  }
  assert.equal(readMs('one'), 3000);
  assert.equal(readMs('word '.repeat(100)), 8000);
});

test('a refusal stays on screen longer than an ordinary step', () => {
  assert.ok(AFTER_REFUSAL_MS > AFTER_STEP_MS && AFTER_STEP_MS >= 2000);
});

test('the whole story takes about a minute and a half, as the docs say', () => {
  const seconds = storyMs(story) / 1000;
  assert.ok(seconds >= 60 && seconds <= 120, `${seconds}s`);
  assert.match(readFileSync(new URL('../docs/DEMO.md', import.meta.url), 'utf8'), /about a minute and a half/);
});

test('reduced motion never shortens reading time, and the play-out can be paused', () => {
  const app = readFileSync(new URL('../demo/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../demo/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /quiet\(\)\s*\?\s*Math\.min/);
  assert.match(app, /pause\(readMs\(step\.say\)\)/);
  assert.match(html, /<button type="button" id="pause" class="quiet" aria-pressed="false" hidden>Pause<\/button>/);
  assert.match(app, /\$\('pause'\)\.hidden = !busy/);
});

test('the narration caption sits below the header, which wraps to two rows on a phone', () => {
  const css = readFileSync(new URL('../demo/style.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../demo/app.js', import.meta.url), 'utf8');
  assert.match(css, /\.caption\{position:sticky;top:var\(--top-h,58px\)/);
  assert.match(app, /setProperty\('--top-h', `\$\{header\?\.offsetHeight \?\? 58\}px`\)/);
  assert.match(app, /addEventListener\('resize', fitCaption\)/);
});
