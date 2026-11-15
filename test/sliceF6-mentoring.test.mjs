import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../core/store.js';
import { Mentoring } from '../core/mentoring.js';
function setup(t) {
 const store=new Store();t.after(()=>store.close());
 for(const id of ['learner','mentor','leader','outsider'])store.registerPerson(id,{leader:id==='leader'});
 const mentoring=new Mentoring(store);
 return {store,mentoring};
}
const accepted=m=>{m.optIn('learner',true);m.optIn('mentor',true);const id=m.request('learner','mentor','Make the transfer handoff clearer.');m.decide('mentor',id,'accept');return id;};

test('F6 mentoring requires both opt-ins and gives leaders no special participant access',t=>{
 const {store,mentoring:m}=setup(t);
 assert.deepEqual(m.directory('leader'),[]);
 m.optIn('learner',true);assert.throws(()=>m.request('learner','mentor','A private goal'),/opt in/);
 m.optIn('mentor',true);const id=m.request('learner','mentor','A private goal');
 assert.throws(()=>m.decide('leader',id,'accept'),/participant/);
 assert.throws(()=>m.decide('learner',id,'accept'),/invited mentor/);
 m.decide('mentor',id,'accept');m.checkin('learner',id,'Private mentoring check-in about the handoff.');
 assert.equal(m.read('leader',id),null);assert.deepEqual(m.checkins('leader',id),[]);assert.deepEqual(m.list('outsider'),[]);
 assert.equal(m.checkins('mentor',id).length,1);
 assert.throws(()=>m.optIn('effort',true),/person/);
 assert.doesNotMatch(store.exportJsonl(),/Private mentoring check-in/);
 assert.deepEqual(store.search('leader','private mentoring'),[]);
});

test('F6 evidence is private by default, explicit sharing is narrow, and revocation withdraws access',t=>{
 const {mentoring:m}=setup(t),id=accepted(m);
 const privateId=m.addEvidence('learner',id,'My private reflection.');
 assert.equal(m.evidence('learner',privateId).scope,'PRIVATE');assert.equal(m.evidence('mentor',privateId),null);assert.equal(m.evidence('leader',privateId),null);
 const mentorId=m.addEvidence('learner',id,'Shared with my mentor.',{scope:'MENTOR_ONLY'});
 assert.equal(m.evidence('mentor',mentorId).text,'Shared with my mentor.');assert.equal(m.evidence('leader',mentorId),null);
 assert.throws(()=>m.addEvidence('learner',id,'No implicit sponsor.',{scope:'SPONSOR_SHARED'}),/name the person/);
 const shared=m.addEvidence('learner',id,'One explicit sponsor receipt.',{scope:'SPONSOR_SHARED',shared_with:'leader'});
 assert.equal(m.evidence('leader',shared).text,'One explicit sponsor receipt.');assert.equal(m.read('leader',id),null);
 assert.throws(()=>m.revoke('leader',shared),/owner/);
 m.revoke('learner',shared);assert.equal(m.evidence('leader',shared),null);assert.ok(m.evidence('learner',shared).revoked_at);
});

test('F6 withdrawal closes active mentoring and disabled participants cannot read or add private data',t=>{
 const {store,mentoring:m}=setup(t),id=accepted(m);
 m.checkin('mentor',id,'A useful next practice.');
 const shared=m.addEvidence('mentor',id,'A mentor-owned receipt.',{scope:'SPONSOR_SHARED',shared_with:'leader'});
 assert.ok(m.evidence('leader',shared));
 m.optIn('mentor',false);assert.equal(m.evidence('leader',shared),null);assert.equal(m.read('learner',id).status,'closed');
 assert.throws(()=>m.checkin('learner',id,'Another note'),/opted-in/);
 assert.equal(m.directory('learner').some(row=>row.person==='mentor'),false);
 store.db.prepare('INSERT INTO person_state(id,disabled) VALUES(?,1)').run('learner');
 assert.equal(m.read('learner',id),null);assert.deepEqual(m.checkins('learner',id),[]);
 assert.deepEqual(m.directory('learner'),[]);
});
