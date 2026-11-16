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




test('F6 mentoring HTTP keeps participant notes private from leaders and shared evidence revocable', async () => {
 const store=new Store(),auth=new Auth(store),password='fixture-mentoring-password-9';
 for(const id of ['learner','mentor','leader'])await auth.createUser(id,password,id==='leader');
 const handler=createHandler({store,auth,secure:false,origin:'http://localhost'});
 const login=async id=>{const r=await call(handler,'POST','/api/login',{id,password});return {cookie:r.headers['set-cookie'].split(';')[0],origin:'http://localhost','x-csrf-token':r.body.csrf};};
 const learner=await login('learner'),mentor=await login('mentor'),leader=await login('leader');
 assert.equal((await call(handler,'GET','/mentoring')).status,403);
 for(const who of [learner,mentor])assert.equal((await call(handler,'POST','/api/mentoring/optin',{enabled:true},who)).status,201);
 const request=await call(handler,'POST','/api/mentoring/requests',{mentor:'mentor',objective:'Make the handoff more useful.'},learner);assert.equal(request.status,201);const id=request.body.id;
 assert.equal((await call(handler,'POST',`/api/mentoring/${id}/decision`,{action:'accept'},leader)).status,409);
 assert.equal((await call(handler,'POST',`/api/mentoring/${id}/decision`,{action:'accept'},mentor)).status,201);
 assert.equal((await call(handler,'POST',`/api/mentoring/${id}/checkin`,{text:'Private hazelnut reflection <img src=x onerror=alert(1)>'},learner)).status,201);
 const ownerPage=await call(handler,'GET',`/mentoring/${id}`,null,learner);assert.match(ownerPage.text,/&lt;img/);assert.doesNotMatch(ownerPage.text,/<img/);
 assert.equal((await call(handler,'GET',`/mentoring/${id}`,null,leader)).status,404);
 assert.doesNotMatch((await call(handler,'GET','/mentoring',null,leader)).text,/hazelnut/);
 const e=await call(handler,'POST',`/api/mentoring/${id}/evidence`,{text:'Private evidence by default.'},learner);assert.equal(e.status,201);
 assert.equal((await call(handler,'GET',`/mentoring/evidence/${e.body.id}`,null,mentor)).status,404);
 const shared=await call(handler,'POST',`/api/mentoring/${id}/evidence`,{text:'Explicit sponsor receipt.',scope:'SPONSOR_SHARED',shared_with:'leader'},learner);
 assert.equal((await call(handler,'GET',`/mentoring/evidence/${shared.body.id}`,null,leader)).status,200);
 assert.equal((await call(handler,'POST',`/api/mentoring/evidence/${shared.body.id}/revoke`,{},leader)).status,409);
 assert.equal((await call(handler,'POST',`/api/mentoring/evidence/${shared.body.id}/revoke`,{},learner)).status,201);
 assert.equal((await call(handler,'GET',`/mentoring/evidence/${shared.body.id}`,null,leader)).status,404);
 assert.deepEqual(store.search('leader','hazelnut'),[]);assert.doesNotMatch(store.exportJsonl(),/hazelnut/);
 store.close();
});

test('F6 SPEC publishing and inclusion preserve typed assumptions and unanswered questions', async()=>{
 const {runInNewContext}=await import('node:vm');const {readFileSync}=await import('node:fs');
 const {specPage}=await import('../app/pages-spec.js');const {initial}=await import('../core/machine.js');
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const draft={assumptions:'The note can be shown.\nA person owns edits.',open_questions:'Who maintains it?',scope_data_sources:'',scope_audiences:''};
 async function submit(dataset,fields){let handler;const calls=[];const form={dataset,fields,matches:()=>true,hasAttribute:()=>false,closest:()=>({querySelector:()=>({fields:draft})})};
  runInNewContext(source,{FormData:class{constructor(target){return Object.entries(target.fields);}},document:{querySelector:()=>null,addEventListener(_name,callback){handler=callback;}},location:{pathname:'/items/i/spec',reload(){}},fetch:async(path,options)=>{if(options)calls.push(JSON.parse(options.body));return{ok:true,status:200,json:async()=>({csrf:'fixture'})};}});
  await handler({preventDefault(){},target:form,submitter:{value:'quoted'}});return calls.at(-1);
 }
 const fields={see_hash:'a'.repeat(64),must:'Keep note',how_we_know:'It persists',out_of_scope:'',...draft};
 for(const result of [await submit({event:'specced'},fields),await submit({include:'spec'},{...fields,base_spec_hash:'b'.repeat(64),comment:'c'.repeat(64)})]){
  assert.deepEqual(result.assumptions,['The note can be shown.','A person owns edits.']);assert.deepEqual(result.open_questions,['Who maintains it?']);
 }
 const spec={type:'specced',actor:'op',body_hash:'b'.repeat(64),must:['Keep note'],how_we_know:['It persists'],out_of_scope:['No export'],assumptions:['A person owns edits.'],open_questions:['Who maintains it?']};
 const html=specPage({id:'i',state:'SPECCED',context:{...initial(),rules:2,steward:'op',seeHash:'a'.repeat(64),specHash:spec.body_hash,specVersion:1}},[spec],'op');
 assert.match(html,/<h2>Open questions<\/h2>/);assert.match(html,/<li>Who maintains it\?<\/li>/);assert.match(html,/Read this version and its changes/);assert.match(html,/<li>No export<\/li>/);
});
