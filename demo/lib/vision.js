import { createLog } from './log.js';
import { makeRoster, people, runToken } from './roster.js';

// Fictional conversation data and a fixture builder. There isn't a server or model.
export function createVisionDemo() {
 let branch=1, log, parentApproval=null;
 const packets=new Map();
 const fresh=()=>{
  const item=`conversation-${branch}`;
  const roster=Object.freeze({...makeRoster(),[runToken]:Object.freeze({kind:'run',leader:false,item}),effort:Object.freeze({kind:'agent',leader:false,item})});
  return createLog({roster,item});
 };
 log=fresh();
 const context=()=>log.replay().context;
 const currentSee=()=>log.events().filter(row=>row.type==='revised').at(-1)?.text||log.events()[0]?.original||'';
 const append=async(type,actor,body={})=>{
  if(log.length>=200)return {ok:false,error:'This demo branch reached its event limit. Reset to try again.'};
  return log.append({...body,type,actor,at:new Date().toISOString()},{idem:`vision:${log.length+1}`});
 };
 const firstReply=async kind=>append('commented','effort',{kind:'agent',job:`fixture:${kind}`,receipt:'fixture receipt',model:'fixture:demo',
  comment:`Fixture Effort (AI): ${kind==='see'?'What happens when the note reaches the next person?':'Which handoff edge case should this draft cover?'}`,
  anchor_kind:kind,anchor_hash:kind==='see'?context().seeHash:context().specHash});
 const api={
  state:()=>({item:log.item,context:context(),events:log.events(),packet:packets.get(context().sent?.packetHash),hasParentApproval:!!parentApproval}),
  async post(actor,original){const out=await append('posted',actor,{original,rules:2});if(out.ok)await firstReply('see');return out;},
  async comment(actor,comment){const c=context();return append('commented',actor,{comment,kind:'concern',anchor_kind:c.specHash?'spec':'see',anchor_hash:c.specHash||c.seeHash});},
  async include(actor,hash){const source=log.events().find(row=>row.type==='commented'&&row.body_hash===hash&&row.actor!=='effort');
   if(!source)return {ok:false,error:'Pick a person\'s comment in this branch.'};
   return append('revised',actor,{base_hash:context().seeHash,text:`${currentSee()}\n${source.comment}`,credits:[{comment:hash,mode:'quoted'}]});},
  async spec(actor,must){const first=!context().specHash;const out=await append('specced',actor,{see_hash:context().seeHash,must:must.split('\n').filter(Boolean),how_we_know:['An independent person checks the handoff.'],out_of_scope:['External data and production deployment']});if(out.ok&&first)await firstReply('spec');return out;},
  async send(actor){const c=context();const packet=JSON.stringify({label:'Fixture decision packet',original:log.events()[0]?.original,see:currentSee(),specHash:c.specHash,
   research:'No source connected, nothing checked',estimate:'No estimate',openConcerns:log.events().filter(row=>row.type==='commented'&&row.actor!=='effort').map(row=>row.comment)});
   const hash=await log.hashArtifact(packet);const out=await append('sent',actor,{spec_hash:c.specHash,packet_hash:hash});if(out.ok)packets.set(hash,packet);return out;},
  approve(actor,reason){const c=context();return append('approved',actor,{spec_hash:c.specHash,packet_hash:c.sent?.packetHash,reason,cap_usd:2,quorum:1,max_iterations:2,window_minutes:10});},
  async deliver(){const c=context();if(c.leash?.expiresAt&&new Date().getTime()>=new Date(c.leash.expiresAt).getTime())return {ok:false,error:'The fixture approval window expired.'};
   const artifact=await log.hashArtifact('Fixture static handoff note. No model built this.');return append('tried',runToken,{approval:c.approval,spec_hash:c.specHash,iteration:c.iteration,artifact_hash:artifact});},
  helps(actor){return append('helped',actor,{artifact_hash:context().artifact});},
  async fork(actor,reason){const previous=log;const row=previous.rows().at(-1);if(!row)return {ok:false,error:'Post a SEE first.'};
   const original=currentSee();parentApproval=previous.events().filter(event=>event.type==='approved').at(-1)||null;
   branch+=1;log=fresh();const out=await append('forked',actor,{original,rules:2,reason,parent:{item:previous.item,seq:row.seq,hash:row.hash}});
   if(!out.ok){log=previous;return out;}await firstReply('see');return out;},
  parentApproval(){return parentApproval?append('approved',parentApproval.actor,parentApproval):Promise.resolve({ok:false,error:'The parent has no approval to reuse.'});},
  verify:()=>log.verify(),
 };
 return api;
}

export function initializeVisionDemo(document) {
 const root=document.getElementById('vision-conversation');if(!root)return;
 let demo=createVisionDemo(),busy=false;
 const actor=()=>root.querySelector('[name=vision-person]').value;
 const status=root.querySelector('[data-vision-status]'),events=root.querySelector('[data-vision-events]'),packet=root.querySelector('[data-vision-packet]'),result=root.querySelector('[data-vision-result]');
 function paint(){const state=demo.state();status.textContent=`${state.item}: ${state.context.phase}. Approval ${state.context.approval}. Original poster: ${state.context.originator||'not posted'}.`;
  packet.textContent=state.packet||'No frozen SEND packet in this branch.';events.replaceChildren();
  for(const event of state.events){const row=document.createElement('li');row.textContent=`${event.actor==='effort'?'Effort (AI fixture)':event.actor}: ${event.type}. ${event.original||event.text||event.comment||event.reason||''}`;
   if(event.type==='commented'&&event.actor!=='effort'){const button=document.createElement('button');button.type='button';button.textContent='Include comment (OP only)';button.addEventListener('click',()=>run(()=>demo.include(actor(),event.body_hash)));row.append(button);}events.append(row);}
 }
 async function run(action){if(busy)return;busy=true;try{const out=await action();result.textContent=out.ok?'Accepted by the real machine.':`Refused: ${out.error}`;}catch{result.textContent='That step failed. Reset to try again.';}finally{busy=false;paint();}}
 root.querySelectorAll('form[data-vision]').forEach(form=>form.addEventListener('submit',event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));
  const actions={post:()=>demo.post(actor(),data.original),comment:()=>demo.comment(actor(),data.comment),spec:()=>demo.spec(actor(),data.must),approve:()=>demo.approve(actor(),data.reason),fork:()=>demo.fork(actor(),data.reason)};run(actions[form.dataset.vision]);}));
 root.querySelector('[data-vision-send]').addEventListener('click',()=>run(()=>demo.send(actor())));
 root.querySelector('[data-vision-deliver]').addEventListener('click',()=>run(()=>demo.deliver()));
 root.querySelector('[data-vision-helps]').addEventListener('click',()=>run(()=>demo.helps(actor())));
 root.querySelector('[data-vision-parent]').addEventListener('click',()=>run(()=>demo.parentApproval()));
 root.querySelector('[data-vision-reset]').addEventListener('click',()=>{if(busy)return;demo=createVisionDemo();result.textContent='Fresh conversation branch.';paint();});
 // People are fixed in code; changing a form never creates a new role.
 const select=root.querySelector('[name=vision-person]');
 for(const person of people){const option=document.createElement('option');option.value=person.id;option.textContent=`${person.name} (${person.leader?'leader':'member'})`;select.append(option);}
 paint();
}
