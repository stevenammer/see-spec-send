// Browser-only acceptance script. Do not run in the sandbox: it needs a real listener and Chrome.
// It documents the F1 three-person journey for root's `npm run test:listen` browser pass.
import assert from 'node:assert/strict';

export async function visionJourney(browser, origin) {
  const op = await browser.newPage();
  await op.goto(`${origin}/items/new`);
  await op.fill('textarea[name="original"]', 'Synthetic callers lose context during transfer.');
  await op.click('button');
  await op.waitForSelector('text=Original');
  await op.waitForSelector('text=Effort');
  await op.click('text=SPEC IT!');
  await op.waitForSelector('text=SEND IT!');
  const leader = await browser.newPage();
  await leader.goto(op.url());
  await leader.waitForSelector('text=Decision packet');
  assert.match(await leader.content(), /Reason for your decision/);
}
