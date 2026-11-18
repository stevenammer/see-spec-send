import assert from 'node:assert/strict';
import test from 'node:test';
import { createVisionDemo } from '../demo/lib/vision.js';

test('F6 anonymous conversation demo follows current rules and never inherits parent approval', async()=>{
 const demo=createVisionDemo();
 assert.equal((await demo.post('nick','The original caller note disappears.')).ok,true);
 assert.equal(demo.state().events[1].actor,'effort');assert.match(demo.state().events[1].comment,/Fixture/);
 assert.equal((await demo.comment('steven','Keep the note visible during transfer.')).ok,true);
 const source=demo.state().events.at(-1).body_hash;
 assert.equal((await demo.include('steven',source)).ok,false);
 assert.equal((await demo.include('nick',source)).ok,true);
 assert.equal(demo.state().events[0].original,'The original caller note disappears.');
 assert.equal((await demo.spec('nick','Keep the caller note visible.')).ok,true);
 assert.equal((await demo.send('nick')).ok,true);assert.match(demo.state().packet,/nothing checked/);
 assert.equal((await demo.approve('nick','I should not approve my own spec.')).ok,false);
 assert.equal((await demo.approve('jose','This small independent try is worth testing.')).ok,true);
 assert.equal((await demo.deliver()).ok,true);
 assert.equal((await demo.helps('nick')).ok,false);assert.equal((await demo.helps('steven')).ok,true);
 assert.equal(demo.state().context.phase,'HELPS');
 assert.equal((await demo.fork('steven','A smaller independent alternative.')).ok,true);
 assert.equal(demo.state().context.phase,'SEEN');assert.equal(demo.state().context.approval,0);assert.equal(demo.state().context.specHash,null);
 assert.equal((await demo.parentApproval()).ok,false);assert.equal((await demo.verify()).ok,true);
});

test('F6 golden dumps round-trip FTS content without recreating shadow tables', async t=>{
 const {Store}=await import('../core/store.js');const {dumpGolden}=await import('../scripts/dump-golden.mjs');
 const {DatabaseSync}=await import('node:sqlite');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'sss-dump-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const input=join(dir,'original.db'),output=join(dir,'restored.db');const source=new Store(input);source.registerPerson('maker');
 source.append('item',{type:'posted',actor:'maker',rules:2,original:'An alpha handoff note.',at:'2026-11-15T10:00:00Z'},{idem:'post'});source.close();
 const dump=dumpGolden(input);assert.doesNotMatch(dump,/CREATE TABLE ['"]?search_docs_data/);
 const raw=new DatabaseSync(output);raw.exec(dump);raw.close();
 const restored=new Store(output);assert.equal(restored.search('maker','alpha').length,1);assert.ok(restored.verifyAll().every(row=>row.ok));restored.close();
});

test('F6 new fork drafts preserve assumptions and questions while earlier fork seeds still restore', async t=>{
 const {Store}=await import('../core/store.js');const s=new Store();t.after(()=>s.close());s.registerPerson('op');s.registerPerson('forker');
 const at='2026-11-15T10:00:00Z';let n=0;const append=(item,event)=>s.append(item,{...event,at},{idem:`meta:${++n}`});
 append('parent',{type:'posted',actor:'op',rules:2,original:'A clearer note handoff.'});
 append('parent',{type:'specced',actor:'op',see_hash:s.read('parent').context.seeHash,must:['Keep note'],how_we_know:['It persists'],out_of_scope:[],assumptions:['The note can be shown'],open_questions:['Who owns edits?']});
 const from={kind:'spec',hash:s.read('parent').context.specHash};
 append('old-child',{type:'forked',actor:'forker',rules:2,...s.forkPoint('parent',from),from});
 append('new-child',{type:'forked',actor:'forker',rules:2,...s.forkPoint('parent',from,undefined,{extended:true}),from,seed_policy:2});
 assert.deepEqual(s.events('new-child')[0].seed_spec.assumptions,['The note can be shown']);
 assert.deepEqual(s.events('new-child')[0].seed_spec.open_questions,['Who owns edits?']);
 assert.equal(s.events('old-child')[0].seed_spec.assumptions,undefined);
 const restored=new Store();t.after(()=>restored.close());restored.importJsonl(s.exportJsonl());assert.ok(restored.verifyAll().every(row=>row.ok));
});
