import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MockLanguageModelV3} from 'ai/test';
import {createGateway} from 'ai';
import {runHostedAgent,type HostedAgentConfig} from '../src/agent/hosted.js';
import {openAuthority} from './fixtures/authority.js';
import {schema,type Snapshot} from '../src/document/index.js';

const usage={inputTokens:{total:20,noCache:20,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}};
const call=(name:string,args:object)=>({type:'tool-call' as const,toolCallId:randomUUID(),toolName:name,input:JSON.stringify(args)});
const response=(content:any[],reason='tool-calls')=>({content,finishReason:{unified:reason as 'stop'|'tool-calls',raw:reason},usage,warnings:[]});
const models=[{id:'fixture-provider/model',name:'Sample model',isDefault:true}];
const config=(model:MockLanguageModelV3):HostedAgentConfig=>({provider:()=>model,models});

test('hosted SDK loop returns stale errors to the model, rereads and preserves human edits',async()=>{
 const work:Promise<void>[]=[];let authority:ReturnType<typeof openAuthority>,id=randomUUID();
 const model=new MockLanguageModelV3({doGenerate:async options=>{
  const count=model.doGenerateCalls.length;
  if(count===1)return response([call('read_document',{})]);
  if(count===2){
   await authority.request({action:'submit',id,version:0,operationId:randomUUID(),clientID:'human',steps:[{stepType:'replace',from:1,to:1,slice:{content:[{type:'text',text:'Human addition.'}]}}]});
   return response([call('append_paragraph',{version:0,text:'Agent addition.'})]);
  }
  if(count===3){assert.match(JSON.stringify(options.prompt),/stale_version/);return response([call('read_document',{})]);}
  if(count===4){assert.match(JSON.stringify(options.prompt),/Human addition/);return response([call('append_paragraph',{version:1,text:'Agent addition.'})]);}
  return response([{type:'text',text:'Added the paragraph and preserved the human addition.'}],'stop');
 }});
 authority=openAuthority(randomUUID(),{...config(model),waitUntil:promise=>work.push(promise)});
 try{
  await authority.request({action:'create',id,title:'Synthetic hosted agent check'});
  const input={action:'chat-send',id,clientID:'human',messageID:randomUUID(),text:'Add one paragraph, preserve other writers.',agent:true,model:models[0].id};
  await authority.request(input);await authority.request(input);assert.equal(work.length,1);await Promise.all(work);
  const snapshot=await authority.request({action:'open',id}) as Snapshot;
  assert.equal(schema.nodeFromJSON(snapshot.doc).textBetween(0,schema.nodeFromJSON(snapshot.doc).content.size,'\n'),'Human addition.\nAgent addition.');
  const chat=await authority.request({action:'chat-state',id,clientID:'human'}) as any;
  assert.equal(chat.run.status,'completed');assert.equal(chat.messages.filter((m:any)=>m.kind==='user').length,1);
  assert.ok(chat.messages.some((m:any)=>m.kind==='tool'&&m.text.includes('rejected')));assert.equal(model.doGenerateCalls.length,5);
 }finally{await authority.close();}
});

test('hosted SDK checks identity before generation, validates tool arguments, and enforces its model allowlist',async()=>{
 const model=new MockLanguageModelV3({doGenerate:[response([call('append_paragraph',{version:'invalid',text:'Invalid'})]),response([{type:'text',text:'No changes applied.'}],'stop')]});
 let writes=0;const execute=async()=>{writes++;return {};},ok=async()=>{};
 assert.equal(await runHostedAgent(config(model),'Try malformed input.',execute,new AbortController().signal,ok),'No changes applied.');assert.equal(writes,0);
 await assert.rejects(runHostedAgent({...config(model),model:'not-allowed'},'No access.',execute,new AbortController().signal,ok),/model_not_allowed/);
 const before=model.doGenerateCalls.length;
 await assert.rejects(runHostedAgent(config(model),'Revoked.',execute,new AbortController().signal,async()=>{throw Error('auth_required');}),/auth_required/);
 assert.equal(model.doGenerateCalls.length,before);
 const stopped=new AbortController();stopped.abort();await assert.rejects(runHostedAgent(config(model),'Stopped.',execute,stopped.signal,ok));assert.equal(model.doGenerateCalls.length,before);
});

test('hosted runs stop across authorities and provider diagnostics never enter shared chat',async()=>{
 let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),work:Promise<void>[]=[];
 const model=new MockLanguageModelV3({doGenerate:async options=>{entered();return new Promise((_,reject)=>{options.abortSignal!.addEventListener('abort',()=>reject(Error('synthetic-private-provider-key')),{once:true});});}});
 const path=randomUUID(),a=openAuthority(path,{...config(model),waitUntil:p=>work.push(p)}),b=openAuthority(path),id=randomUUID();
 try{
  await a.request({action:'create',id,title:'Synthetic stop check'});await a.request({action:'chat-send',id,clientID:'a',messageID:randomUUID(),text:'Wait.',agent:true});await started;
  await b.request({action:'chat-stop',id,clientID:'b'});await Promise.all(work);
  const state=await b.request({action:'chat-state',id,clientID:'b'}) as any;assert.equal(state.run.status,'stopped');assert.doesNotMatch(JSON.stringify(state),/synthetic-private-provider-key/);
 }finally{await a.close();await b.close();}
 let providerCalls=0;const failing=createGateway({apiKey:'synthetic-gateway-key',fetch:async()=>{providerCalls++;return Response.json({error:{message:'synthetic-private-provider-key',type:'insufficient_funds'}},{status:402});}}),failedWork:Promise<void>[]=[];
 const c=openAuthority(randomUUID(),{provider:failing,models,waitUntil:p=>failedWork.push(p)}),document=randomUUID();
 try{await c.request({action:'create',id:document,title:'Synthetic error check'});await c.request({action:'chat-send',id:document,clientID:'c',messageID:randomUUID(),text:'Try.',agent:true});await Promise.all(failedWork);
  const state=await c.request({action:'chat-state',id:document,clientID:'c'}) as any;assert.equal(state.run.status,'failed');assert.equal(providerCalls,1);assert.doesNotMatch(JSON.stringify(state),/synthetic-private-provider-key|synthetic-gateway-key/);
 }finally{await c.close();}
});

test('a concurrent stop cannot be overwritten by a completed assistant response',async()=>{
 const {clients}=await import('./fixtures/authority.js'),{openAuthority:open}=await import('../src/server/index.js');
 const path=randomUUID(),actors=clients(path),get=actors.get.bind(actors),work:Promise<void>[]=[];
 const id=randomUUID(),peer=openAuthority(path);
 let raced=false;
 actors.get=(actor,agent)=>{
  const client=get(actor,agent);if(!agent)return client;
  const commit=client.commits.create.bind(client.commits);
  client.commits.create=async (input:any)=>{
   if(input.operations.some((op:any)=>op.model==='forumRuns'&&op.data.status==='completed')){raced=true;await peer.request({action:'chat-stop',id,clientID:'other-human'});}
   return commit(input);
  };
  return client;
 };
 const model=new MockLanguageModelV3({doGenerate:response([{type:'text',text:'Finished.'}],'stop')}),a=open({...config(model),waitUntil:p=>work.push(p)},actors);
 try{
  await a.request({action:'create',id,title:'Synthetic completion race'});await a.request({action:'chat-send',id,clientID:'human',messageID:randomUUID(),text:'Finish.',agent:true});await Promise.all(work);
  const state=await peer.request({action:'chat-state',id,clientID:'human'}) as any;
  assert.equal(raced,true);assert.equal(state.run.status,'stopped');assert.equal(state.messages.filter((m:any)=>m.kind==='assistant').length,0);
 }finally{await a.close();await peer.close();}
});

test('hosted RPC membership revocation aborts its running model after the bounded identity lease',async()=>{
 const {hostedService}=await import('../src/hosted/index.js'),work:Promise<void>[]=[];
 let revoked=false,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 const model=new MockLanguageModelV3({doGenerate:async options=>{entered();return new Promise((_,reject)=>options.abortSignal!.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});
 const a=openAuthority(randomUUID(),{...config(model),waitUntil:p=>work.push(p)}),id=randomUUID();
 const service=hostedService({verify:async()=>{if(revoked)throw Error('auth_required');return {userId:'sample',organizationId:'sample-team',workspace:'sample-team',name:'Sample'};},authority:()=>a});
 const rpc=(input:unknown)=>service(new Request('https://forum.abloatai.com/api/rpc',{method:'POST',headers:{authorization:'Bearer sample-session'},body:JSON.stringify(input)}));
 try{
  assert.equal((await rpc({action:'create',id,title:'Synthetic revocation check'})).status,200);
  assert.equal((await rpc({action:'chat-send',id,clientID:'sample',messageID:randomUUID(),text:'Wait.',agent:true})).status,200);await started;revoked=true;
  await Promise.race([Promise.all(work),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Revocation was not enforced')),8000);timer.unref();})]);
  const state=await a.request({action:'chat-state',id,clientID:'sample'}) as any;assert.equal(state.run.status,'stopped');assert.equal(state.messages.some((m:any)=>m.kind==='assistant'),false);assert.equal(model.doGenerateCalls.length,1);
  assert.equal((await rpc({action:'open',id})).status,401);
 }finally{await a.close();}
});

test('a stop racing the document commit rejects the edit as well as its assistant summary',async()=>{
 const {clients}=await import('./fixtures/authority.js'),{openAuthority:open}=await import('../src/server/index.js');
 const path=randomUUID(),actors=clients(path),get=actors.get.bind(actors),work:Promise<void>[]=[],id=randomUUID(),peer=openAuthority(path);let raced=false;
 actors.get=(actor,agent)=>{
  const client=get(actor,agent);if(!agent)return client;
  const commit=client.commits.create.bind(client.commits);
  client.commits.create=async(input:any)=>{
   if(input.operations.some((op:any)=>op.model==='forumDocuments'&&op.action==='update')){raced=true;await peer.request({action:'chat-stop',id,clientID:'peer'});}
   return commit(input);
  };return client;
 };
 const model=new MockLanguageModelV3({doGenerate:[response([call('read_document',{})]),response([call('append_paragraph',{version:0,text:'Must not commit.'})]),response([{type:'text',text:'Must not publish.'}],'stop')]});
 const a=open({...config(model),waitUntil:p=>work.push(p)},actors);
 try{
  const before=await a.request({action:'create',id,title:'Stop edit race'});
  await a.request({action:'chat-send',id,clientID:'human',messageID:randomUUID(),text:'Append.',agent:true});await Promise.all(work);
  assert.ok(raced);assert.deepEqual(await a.request({action:'open',id}),before);
  const state=await peer.request({action:'chat-state',id,clientID:'peer'}) as any;assert.equal(state.run.status,'stopped');assert.equal(state.messages.filter((m:any)=>m.kind==='assistant').length,0);
 }finally{await a.close();await peer.close();}
});

test('hosted generation stops at its tool-step budget instead of running indefinitely',async()=>{
 const model=new MockLanguageModelV3({doGenerate:async()=>response([call('read_document',{})])});let executed=0;
 await assert.rejects(runHostedAgent(config(model),'Keep reading.',async()=>{executed++;return {version:0};},new AbortController().signal,async()=>{}),/agent_limit_reached/);
 assert.equal(model.doGenerateCalls.length,12);assert.equal(executed,12);
});
