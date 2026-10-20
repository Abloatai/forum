import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {personalCodex} from '../src/codex/index.js';
import {encryptedStore,type Store,type Saved} from '../src/codex/storage.js';
import {openAccount} from '../src/codex/account.js';
import {clients,openAuthority} from './fixtures/authority.js';
const model={id:'sample-codex',name:'Sample Codex',isDefault:true};
function memory(){const rows=new Map<string,Saved>();const store:Store={async read(user){return rows.get(user)??{value:{generation:''}};},async write(user,value,previous){const current=await store.read(user);if(current.value.generation!==previous.value.generation)throw new Error('stale_context');const next={value};rows.set(user,next);return next;}};return store;}
function account(success=true){let complete!:(value:boolean)=>void;const completed=new Promise<boolean>(resolve=>complete=resolve);return {complete,open:async()=>({home:'unused',completed,close:async()=>{},snapshot:async()=>'',request:async<T>()=>({verificationUrl:'https://auth.openai.com/codex/device',userCode:'SAMPLE-CODE',loginId:'private-native-login-id'} as T),read:async()=>{if(!success)throw new Error('synthetic failure');return {auth:JSON.stringify({tokens:{access_token:'synthetic-private-token',account_id:'sample'}}),view:{email:'sample@example.test',plan:'plus',models:[model]}};}})};}
test('Codex device connection belongs only to the signed-in user and disconnect revokes captured agent configuration',async()=>{
 const store=memory(),sample=account(),work:Promise<void>[]=[],codex=personalCodex(store,sample.open,p=>work.push(p));
 assert.deepEqual(await codex.request('alice','codex-status'),{connected:false});assert.equal(await codex.agent('alice'),undefined);
 const login=await codex.request('alice','codex-connect');assert.equal(login.login?.userCode,'SAMPLE-CODE');assert.ok(!JSON.stringify(login).includes('private-native-login-id'));assert.equal(work.length,1);
 assert.deepEqual(await codex.request('alice','codex-connect'),login);sample.complete(true);await Promise.all(work);
 const state=await codex.request('alice','codex-status');assert.equal(state.connected,true);assert.ok(!JSON.stringify(state).includes('synthetic-private-token'));assert.equal(await codex.agent('bob'),undefined);
 const agent=await codex.agent('alice');assert.deepEqual(agent?.models,[model]);await codex.request('alice','codex-disconnect');
 await assert.rejects(agent!.run(model.id,'Must not run',()=>{throw new Error('Must not call a tool');},new AbortController().signal,async()=>{}),/codex_connection_required/);
 assert.equal((await codex.request('alice','codex-status')).connected,false);
});
test('disconnect during device approval cannot reconnect the account; failed approval remains disconnected',async()=>{
 const store=memory(),sample=account(),work:Promise<void>[]=[],codex=personalCodex(store,sample.open,p=>work.push(p));
 await codex.request('alice','codex-connect');await codex.request('alice','codex-disconnect');sample.complete(true);await Promise.all(work);assert.equal((await codex.request('alice','codex-status')).connected,false);
 const failed=account(),jobs:Promise<void>[]=[],other=personalCodex(store,failed.open,p=>jobs.push(p));await other.request('alice','codex-connect');failed.complete(false);await Promise.all(jobs);assert.equal((await other.request('alice','codex-status')).connected,false);assert.match((await other.request('alice','codex-status')).error!,/did not complete/);
});
test('encrypted Ablo credentials reject another user, tampering and stale writes',async()=>{
 const client=clients(randomUUID()).get('server'),store=encryptedStore('ab'.repeat(32),'unused',client),initial=await store.read('alice');
 const first=await store.write('alice',{generation:'one',auth:'synthetic-private-auth'},initial);assert.equal(first.value.auth,'synthetic-private-auth');assert.ok(!JSON.stringify(first.proof).includes('synthetic-private-auth'));
 await store.write('alice',{generation:'two'},first);await assert.rejects(store.write('alice',{generation:'old'},first),/stale_context/);
 assert.deepEqual((await store.read('bob')).value,{generation:''});
 const rows=await client.forumCodexConnections.list({limit:10});const payload=rows[0].payload;await client.forumCodexConnections.update({id:rows[0].id,data:{payload:payload.slice(0,-8)+'AAAAAAAA'}});await assert.rejects(store.read('alice'));
 assert.throws(()=>encryptedStore('bad','unused',client),/invalid_codex_encryption_key/);
});
test('shared documents do not share personal model access or create charged messages for unconnected members',async()=>{
 const store=memory(),codex=personalCodex(store),authority=openAuthority(randomUUID(),actor=>codex.agent(actor));const id=randomUUID(),clientID=randomUUID();
 try{await authority.request({action:'create',id,title:'Sample'},'alice');const state=await authority.request({action:'chat-state',id,clientID},'bob') as any;assert.equal(state.agent,null);
 await assert.rejects(authority.request({action:'chat-send',id,clientID,messageID:randomUUID(),text:'Should not run',agent:true,model:model.id},'bob'),/agent_unavailable/);
 assert.deepEqual((await authority.request({action:'chat-state',id,clientID},'bob') as any).messages,[]);
 await authority.request({action:'chat-send',id,clientID,messageID:randomUUID(),text:'Human chat still works',agent:false,model:model.id},'bob');
 }finally{await authority.close();}
});
test('native account process uses isolated ChatGPT auth and public catalog only',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'forum-account-fixture-')),command=join(directory,'codex');
 await writeFile(command,`#!/usr/bin/env node\nconst {createInterface}=require('node:readline');const {writeFileSync}=require('node:fs');const {join}=require('node:path');createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='account/login/start'){writeFileSync(join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{access_token:'synthetic',account_id:'sample'}}),{mode:384});result={verificationUrl:'https://auth.openai.com/codex/device',userCode:'SAMPLE'};process.stdout.write(JSON.stringify({method:'account/login/completed',params:{success:true}})+'\\n');}if(m.method==='account/read')result={account:{type:'chatgpt',email:'sample@example.test',planType:'plus'}};if(m.method==='model/list')result={data:[{model:'sample',displayName:'Sample',isDefault:true}]};if(m.method==='environment')result={hasApiKey:!!process.env.ANTHROPIC_API_KEY||!!process.env.OPENAI_API_KEY||!!process.env.ABLO_API_KEY,isolated:process.env.HOME===process.env.CODEX_HOME};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`,{mode:0o700});
 const session=await openAccount(undefined,command);try{await session.request('account/login/start',{type:'chatgptDeviceCode'});assert.equal(await session.completed,true);const result=await session.read(true);assert.equal(result.view.models[0].id,'sample');assert.match(result.auth,/synthetic/);assert.deepEqual(await session.request('environment'),{hasApiKey:false,isolated:true});assert.equal(await session.snapshot(),result.auth);}finally{await session.close();await rm(directory,{recursive:true,force:true});}
});
test('a personal run refreshes only its owner, exposes only that auth to the child and checks revocation around tools',async()=>{
 const store=memory(),sample=account(),jobs:Promise<void>[]=[],codex=personalCodex(store,sample.open,p=>jobs.push(p),async(config,prompt,tool,signal,check)=>{
  assert.ok(!('provider'in config)&&!('personal'in config));if('provider'in config||'personal'in config)throw new Error('wrong route');
  const {readFile}=await import('node:fs/promises');assert.match(await readFile(join(config.home,'auth.json'),'utf8'),/synthetic-private-token/);await check!();await tool('read_document',{});await check!();return 'Confirmed.';
 });
 await codex.request('alice','codex-connect');sample.complete(true);await Promise.all(jobs);
 const old=await store.read('alice');await store.write('alice',{...old.value,updatedAt:0},old);
 const agent=await codex.agent('alice');let reads=0;assert.equal(await agent!.run(model.id,'Read only',()=>{reads++;return {};},new AbortController().signal,async()=>{}),'Confirmed.');assert.equal(reads,1);
 assert.equal(await codex.agent('bob'),undefined);
 await assert.rejects(agent!.run(model.id,'Revoke',async()=>{await codex.request('alice','codex-disconnect');},new AbortController().signal,async()=>{}),/codex_connection_required/);
});
