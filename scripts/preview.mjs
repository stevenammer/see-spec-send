// Local fixture preview. Uses a separate private database and never calls a vendor.
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';

const portAt=process.argv.indexOf('--port');const port=portAt<0?8790:Number(process.argv[portAt+1]);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Choose a local port between1024and65535.');
const root=new URL('..',import.meta.url).pathname;
const state=join(homedir(),'.local','state','see-spec-send','preview');mkdirSync(state,{recursive:true,mode:0o700});chmodSync(state,0o700);
const lock=join(state,'preview.pid');
if(existsSync(lock)){
 const previous=Number(readFileSync(lock,'utf8'));let alive=false;
 try{process.kill(previous,0);alive=true;}catch(error){if(error.code!=='ESRCH')alive=true;}
 if(alive)throw Error(`A process still owns the preview lock (PID ${previous}). Inspect it before starting another preview.`);
 unlinkSync(lock);
}
writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
const access=join(state,'ACCESS.txt'),file=join(state,'preview.db');let accessText='';
const cleanLock=()=>{if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);};
try{
 if(!existsSync(access)&&existsSync(file))throw Error('Existing preview database has no access record. Preserve it and choose recovery before resetting.');
 const store=new Store(file),auth=new Auth(store);
 if(!existsSync(access)){
  const password=randomBytes(15).toString('base64url');
  for(const [id,leader]of [['nick',false],['steven',false],['jose',true]])await auth.createUser(id,password,leader);
  accessText=`Local fixture preview. No real model or vendor is called.\nMembers: nick, steven\nIndependent leader: jose\nPassword for these preview accounts: ${password}\nData stays in this separate preview database.\n`;
  writeFileSync(access,accessText,{flag:'wx',mode:0o600});
 }else accessText=readFileSync(access,'utf8');
 const ledger=new Ledger(store);if(!store.db.prepare('SELECT 1 FROM gateway_policy WHERE id=1').get())ledger.configure(fixturePolicy());store.close();
}catch(error){cleanLock();throw error;}
const origin=`http://127.0.0.1:${port}`;
console.log(`Local app: ${origin}\n${accessText}Access record: ${access}`);
const env={...process.env,SSS_DB:file};
const children=[spawn(process.execPath,['cli.js','serve','--port',String(port),'--origin',origin,'--insecure-cookies','--enable-effort','--fixture'],{cwd:root,env,stdio:'inherit'}),spawn(process.execPath,['cli.js','worker'],{cwd:root,env,stdio:'inherit'})];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');process.exitCode=code;}
for(const child of children){child.on('error',()=>stop(1));child.on('exit',code=>{if(!stopping)stop(code||1);});}
process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());process.once('exit',cleanLock);
