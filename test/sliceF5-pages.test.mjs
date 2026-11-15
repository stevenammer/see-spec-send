import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { researchRecord } from '../research/connectors.js';

class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }
  end(value = '') { this.text += value; }
}

const call = async (handler, method, path, input = null, headers = {}) => {
  const req = Readable.from(input === null ? [] : [JSON.stringify(input)]);
  req.method = method; req.url = path;
  req.headers = { ...(input === null ? {} : { 'content-type': 'application/json' }), ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response(); await handler(req, res);
  return { status: res.status, headers: res.headers, text: res.text,
    body: res.headers['content-type']?.includes('application/json') ? JSON.parse(res.text) : null };
};



test('F5 signed-in search, source records and contributions escape content and honor erasure', async () => {
  const store = new Store(), auth = new Auth(store), password = 'fixture-only-search-password-9';
  for (const id of ['op','member']) await auth.createUser(id,password,false);
  const handler = createHandler({ store, auth, secure:false, origin:'http://localhost' });
  const login=await call(handler,'POST','/api/login',{id:'op',password});
  const headers={cookie:login.headers['set-cookie'].split(';')[0],origin:'http://localhost','x-csrf-token':login.body.csrf};
  assert.equal((await call(handler,'GET','/search?q=quartz')).status,403);
  const post=await call(handler,'POST','/api/items',{original:'Transfer notes need a clearer handoff.'},headers);const id=post.body.id;
  const see=store.read(id).context.seeHash;
  store.append(id,{type:'commented',actor:'member',kind:'comment',anchor_kind:'see',anchor_hash:see,comment:'quartz <img src=x onerror=alert(1)>',at:new Date().toISOString()},{idem:'comment'});
  const comment=store.events(id).at(-1).body_hash;
  const page=await call(handler,'GET','/search?q=quartz',null,headers);
  assert.equal(page.status,200); assert.match(page.text,/&lt;img/);assert.doesNotMatch(page.text,/<img/);
  const record=await call(handler,'GET',`/items/${id}/record/${comment}`,null,headers);
  assert.match(record.text,/Acknowledge this contribution/);
  assert.equal((await call(handler,'POST',`/api/items/${id}/events`,{type:'credit_note',person:'member',source:comment,note:'The example clarified the missing detail.'},headers)).status,201);
  const credits=await call(handler,'GET','/people/member',null,headers);assert.match(credits.text,/credited/);assert.match(credits.text,/Contribution source/);
  const off=await call(handler,'POST',`/api/items/${id}/research`,{},headers);assert.equal(off.status,201);
  assert.equal(store.events(id).at(-1).sources['internal prior work'].status,'not connected');
  store.db.prepare("UPDATE research_config SET enabled=1 WHERE source='this_workspace'").run();
  assert.equal((await call(handler,'POST',`/api/items/${id}/research`,{},headers)).status,201);
  assert.equal(store.events(id).at(-1).sources['internal prior work'].status,'checked');
  store.erase(id,comment,'member',new Date().toISOString());
  const erased=await call(handler,'GET',`/items/${id}/record/${comment}`,null,headers);assert.match(erased.text,/content was erased/);assert.doesNotMatch(erased.text,/quartz/);
  assert.doesNotMatch((await call(handler,'GET','/search?q=quartz',null,headers)).text,/quartz &lt;img/);
  assert.ok(store.verifyAll().every(row=>row.ok));store.close();
});
