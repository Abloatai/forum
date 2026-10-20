import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {schema,defaultPaper,emptyDocument,type Snapshot} from '../src/document/index.js';
import {documentTool} from '../src/agent/tools.js';
import {openAuthority as open} from '../src/server/index.js';
import {clients,openAuthority,startServer} from './fixtures/authority.js';
import {connectBridge,BridgeError} from '../src/realtime/index.js';
import {client} from './fixtures/editor.js';
import {concurrentEditors} from './fixtures/concurrent-editors.js';

test('overlapping agent replacements reject stale or missing targets without overwriting the first edit',async()=>{
 const path=randomUUID(),a=openAuthority(path),b=openAuthority(path),id=randomUUID();
 try{
  await a.request({action:'create',id,title:'Conflicting edits'});
  await documentTool(a.request,id,'seed','append_paragraph',{version:0,text:'A small document.'});
  const [alpha,beta]=await Promise.all([documentTool(a.request,id,'alpha','read_document',{}),documentTool(b.request,id,'beta','read_document',{})]) as Snapshot[];
  await documentTool(a.request,id,'alpha','replace_text',{version:alpha.version,find:'small',text:'focused'});
  await assert.rejects(documentTool(b.request,id,'beta','replace_text',{version:beta.version,find:'small',text:'expanded'}),/stale_version/);
  const latest=await documentTool(b.request,id,'beta','read_document',{}) as Snapshot;
  await assert.rejects(documentTool(b.request,id,'beta','replace_text',{version:latest.version,find:'small',text:'expanded'}),/text_not_unique/);
  assert.deepEqual(await documentTool(a.request,id,'alpha','read_document',{}),latest);
  assert.equal(schema.nodeFromJSON(latest.doc).textContent,'A focused document.');
 }finally{await a.close();await b.close();}
});

test('a lost commit response recovers its durable receipt and never duplicates a document step',async()=>{
 const actors=clients(randomUUID()),get=actors.get.bind(actors);let injected=false;
 actors.get=(...args)=>{
  const actor=get(...args),commit=actor.commits.create.bind(actor.commits);
  actor.commits.create=async(input:any)=>{const result=await commit(input);if(!injected&&input.operations.some((op:any)=>op.model==='forumReceipts')){injected=true;throw Error('simulated_response_loss');}return result;};
  return actor;
 };
 const a=open(undefined,actors),id=randomUUID();
 try{
  const snapshot=await a.request({action:'create',id,title:'Response loss'}) as Snapshot,c=client(snapshot,'writer');c.insert('Once only.');
  const request=c.request(),accepted=await a.request(request);assert.equal(injected,true);assert.deepEqual(accepted,{accepted:true,version:1});
  assert.deepEqual(await a.request(request),accepted);
  const current=await a.request({action:'open',id}) as Snapshot;assert.equal(current.version,1);assert.equal(schema.nodeFromJSON(current.doc).textContent,'Once only.');
  const changes=await a.request({action:'changes',id,version:0}) as any;assert.equal(changes.steps.length,1);
 }finally{await a.close();}
});

test('twelve OT clients converge after 96 competing edits and repeated disconnects',async()=>{
 const token='synthetic-load-token-'.repeat(3),server=await startServer({database:randomUUID(),token,agent:null});
 const bridges=Array.from({length:12},()=>connectBridge(server.url,token));
 try{
  let dropped=false;
  const observed=bridges.map(bridge=>({...bridge,request:async(input:Parameters<typeof bridge.request>[0])=>{
   const result=await bridge.request(input);
   if(!dropped&&input.action==='submit'&&(result as {accepted:boolean}).accepted){dropped=true;bridge.disconnect();throw new BridgeError('outcome_unknown');}
   return result;
  }}));
  const result=await concurrentEditors(observed,8);assert.equal(result.edits,96);assert.ok(result.conflicts>0);assert.ok(result.recoveries>0);
 }
 finally{for(const bridge of bridges)bridge.close();await server.close();}
});

test('decision contention retries the exact commit while changed captured reads require a reread',async()=>{
 const {commit}=await import('../src/ablo/index.js'),path=randomUUID(),actors=clients(path),actor=actors.get('writer'),raw=actor.commits.create.bind(actor.commits);
 const id=randomUUID(),input={operations:[{action:'create' as const,model:'forumDocuments',id,data:{workspace:'local',time:0,title:'Retry',doc:JSON.stringify(emptyDocument),version:0,layout:'page',paper:JSON.stringify(defaultPaper)}}],idempotencyKey:randomUUID(),wait:'confirmed' as const};
 let attempts=0;
 actor.commits.create=async request=>{assert.strictEqual(request,input);attempts++;if(attempts<3)throw Object.assign(Error('Busy'),{code:'decision_contended'});return raw(request);};
 await commit(actor,input);assert.equal(attempts,3);assert.ok(await actor.forumDocuments.read({id}));
 const original=await actor.forumDocuments.read({id}),peer=actors.get('peer');await peer.forumDocuments.update({id,data:{title:'Changed by peer'}});
 actor.commits.create=async request=>{attempts++;return raw(request);};const before=attempts;
 await assert.rejects(commit(actor,{operations:[{action:'update',model:'forumDocuments',id,data:{title:'Must not overwrite'}}],reads:[original!],idempotencyKey:randomUUID(),wait:'confirmed'}),{code:'stale_context'});
 assert.equal(attempts,before+1);assert.equal((await actor.forumDocuments.read({id}))!.title,'Changed by peer');
});

test('persistent contention has a finite retry budget and unrelated failures are not retried',async()=>{
 const {commit}=await import('../src/ablo/index.js'),actor=clients(randomUUID()).get('writer');let calls=0;
 const request={operations:[],idempotencyKey:randomUUID(),wait:'confirmed' as const};
 actor.commits.create=async()=>{calls++;throw Object.assign(Error('Busy'),{code:'decision_contended'});};
 await assert.rejects(commit(actor,request),{code:'decision_contended'});assert.equal(calls,6);
 for(const code of ['auth_required','stale_context','idempotency_conflict']){
  calls=0;actor.commits.create=async()=>{calls++;throw Object.assign(Error('Do not retry'),{code});};
  await assert.rejects(commit(actor,request),{code});assert.equal(calls,1);
 }
});
