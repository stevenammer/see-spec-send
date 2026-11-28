import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
if(!process.env.NODE_TEST_CONTEXT)await main();
async function main(){
 const require=createRequire(import.meta.url),playwright=require(join(process.env.PLAYWRIGHT_DIR||'','playwright'));
 const root=new URL('../../demo/',import.meta.url).pathname;
 const server=createServer((req,res)=>{try{const name=new URL(req.url,'http://localhost').pathname;const path=resolve(root,'.'+(name==='/'?'/index.html':name));if(!path.startsWith(root))throw Error('path');res.setHeader('content-type',path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(readFileSync(path));}catch{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
  try{
  const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);
  await page.locator('#viewer option[value=nick]').waitFor({state:'attached'});
  // Nothing is posted yet: the start-a-post box shows and no half-drawn post does.
  assert.equal(await page.locator('#post').isVisible(),false);
  assert.equal(await page.locator('#empty').isVisible(),true);
  await page.getByRole('button',{name:'Post it'}).click();
  await page.getByText('Canned text. No model is running in this demo.').first().waitFor();
  assert.equal(await page.locator('#post').isVisible(),true);
  // Steven comments with hostile text. It stays text.
  await page.locator('#viewer').selectOption('steven');
  await page.locator('#form-comment [name=comment]').fill('Keep the original note visible. <img src=x onerror=alert(1)>');
  await page.getByRole('button',{name:'Reply',exact:true}).click();
  // Nick includes it and credits Steven.
  await page.locator('#viewer').selectOption('nick');
  await page.getByRole('button',{name:'Include this in the spec and credit them'}).click();
  await page.getByText("Nick added Steven's comment to the problem and credited Steven.").waitFor();
  // Steven tries to write the spec: refused, in plain words.
  await page.locator('#viewer').selectOption('steven');
  await page.getByRole('button',{name:'Write the spec'}).click();
  await page.locator('.card.refused').getByText(/Only Nick, who posted it, can do that/).waitFor();
  await page.locator('#viewer').selectOption('nick');
  await page.getByRole('button',{name:'Write the spec'}).click();
  await page.locator('.card.spec').waitFor();
  await page.getByRole('button',{name:'Send it for a decision'}).click();
  // Nick (not a leader) tries to spend it: refused. Jose does it.
  await page.getByRole('button',{name:/Spend it \(approve a small try\)/}).click();
  await page.locator('.card.refused').getByText(/isn't a leader|wrote this spec/).first().waitFor();
  await page.locator('#viewer').selectOption('jose');
  await page.getByRole('button',{name:/Spend it \(approve a small try\)/}).click();
  await page.getByRole('button',{name:'Let the builder deliver the try'}).click();
  // The rule: the approver and the spec's author are both refused, and a made-up done is refused.
  await page.getByRole('button',{name:/It helps \(as Jose\)/}).click();
  await page.locator('.card.refused').getByText(/Jose approved it/).waitFor();
  await page.locator('#viewer').selectOption('nick');
  await page.getByRole('button',{name:/It helps \(as Nick\)/}).click();
  await page.locator('.card.refused').getByText(/Nick shaped this one/).waitFor();
  await page.getByRole('button',{name:'Try to mark it done by hand'}).click();
  await page.locator('.card.refused').getByText(/no "done" event/).waitFor();
  assert.equal(await page.locator('#vote-count').textContent(),'0');
  // Two other people, and only then does it count.
  await page.locator('#viewer').selectOption('steven');
  await page.getByRole('button',{name:/It helps \(as Steven\)/}).click();
  assert.equal(await page.locator('#vote-count').textContent(),'1');
  await page.locator('#viewer').selectOption('cleo');
  await page.getByRole('button',{name:/It helps \(as Cleo\)/}).click();
  await page.getByRole('heading',{name:'It helps.',exact:true}).waitFor();
  // The record verifies, and an edit is caught.
  await page.getByRole('button',{name:'Verify the chain'}).click();
  await page.getByText(/The chain checks out/).waitFor();
  await page.getByRole('button',{name:'Edit an event'}).click();
  await page.getByRole('button',{name:'Verify the chain'}).click();
  await page.getByText(/The chain is broken/).waitFor();
  // A fork starts with no approval and can't reuse the old one.
  await page.getByRole('button',{name:'Fork it',exact:true}).click();
  await page.getByRole('button',{name:'Reuse the old approval'}).click();
  await page.locator('.card.refused').getByText(/never inherits the approval/).waitFor();
  assert.equal(await page.locator('img').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no sideways scroll on a phone');
  // The scripted play-through runs end to end with the same engine.
  await page.getByRole('button',{name:'Start over'}).click();
  await page.getByRole('button',{name:'Watch it play out'}).click();
  await page.waitForFunction(()=>document.querySelector('#caption')?.textContent.startsWith("That's the whole rule"),null,{timeout:150000});
  assert.equal(await page.locator('.card.refused').count(),3,'three refusals in the story');
  assert.equal(await page.locator('#vote-count').textContent(),'2');
  assert.equal(await page.locator('img').count(),0);assert.deepEqual(errors,[]);
  console.log('PASS: the forum-style demo at 390px: post, comments, include and credit, plain-words refusals, independent approval, Helps only from others, chain verify and tamper, fork refusal, the scripted story, hostile text inert.');
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
