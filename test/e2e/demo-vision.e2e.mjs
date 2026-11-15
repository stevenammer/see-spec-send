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
  await page.goto(origin);const root=page.locator('#vision-conversation');
  await root.locator('[name=vision-person] option[value=maya]').waitFor({state:'attached'});
  await root.getByRole('button',{name:'Post conversation SEE'}).click();await root.getByText(/Effort \(AI fixture\)/).first().waitFor();
  await root.locator('[name=vision-person]').selectOption('ben');await root.locator('[name=comment]').fill('Keep the original note visible. <img src=x onerror=alert(1)>');
  await root.getByRole('button',{name:'Comment on conversation'}).click();await root.getByRole('button',{name:'Include comment (OP only)'}).waitFor();
  await root.locator('[name=vision-person]').selectOption('maya');await root.getByRole('button',{name:'Include comment (OP only)'}).click();await root.locator('[data-vision-events] > li').filter({hasText:'maya: revised.'}).waitFor();
  await root.getByRole('button',{name:'SPEC IT! (OP only)'}).click();await root.getByText(/Fixture Effort \(AI\): Which handoff/).waitFor();
  await root.getByRole('button',{name:'SEND IT! (OP only)'}).click();await root.locator('[data-vision-status]').filter({hasText:'SUBMITTED'}).waitFor();
  await root.getByRole('button',{name:'Approve conversation (independent leader)'}).click();await root.locator('[data-vision-result]').filter({hasText:'Refused:'}).waitFor();
  await root.locator('[name=vision-person]').selectOption('lena');await root.getByRole('button',{name:'Approve conversation (independent leader)'}).click();await root.locator('[data-vision-status]').filter({hasText:'SENDING'}).waitFor();
  await root.getByRole('button',{name:'Deliver fixture try'}).click();await root.locator('[data-vision-status]').filter({hasText:'TRYING'}).waitFor();
  await root.locator('[name=vision-person]').selectOption('ben');await root.getByRole('button',{name:'Say this try helps'}).click();await root.locator('[data-vision-status]').filter({hasText:'HELPS'}).waitFor();
  await root.getByRole('button',{name:'Fork conversation',exact:true}).click();await root.locator('[data-vision-status]').filter({hasText:'Approval 0'}).waitFor();
  await root.getByRole('button',{name:"Try reusing the parent's approval"}).click();await root.locator('[data-vision-result]').filter({hasText:'Refused:'}).waitFor();
  assert.equal(await page.locator('img').count(),0);assert.deepEqual(errors,[]);
  console.log('PASS: current anonymous conversation demo at390px, fixture labels, OP include, independent approval, fork refusal, hostile text inert.');
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
