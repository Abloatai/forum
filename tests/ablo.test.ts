import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {EditorState} from '@tiptap/pm/state';
import {schema,type Snapshot} from '../src/document/index.js';
import {startServer} from '../src/server/index.js';
import {connectBridge} from '../src/realtime/index.js';

test('live Ablo: separate native authorities, atomic competing edits, retry receipts, two agents and two humans',{skip:!process.env.ABLO_API_KEY,timeout:180_000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'forum-live-')),token='synthetic-live-'.repeat(4),id=randomUUID();
 const agent={command:resolve('tests/fixtures/agent.mjs'),home:dir,scripted:true};
 const first=await startServer({token,agent}),second=await startServer({token,agent});
 const a=connectBridge(first.url,token),b=connectBridge(second.url,token);
 const state=()=>b.request({action:'chat-state',id,clientID:'bob'}) as Promise<any>;
 async function waitFor(predicate:(value:any)=>boolean){const deadline=Date.now()+90_000;while(Date.now()<deadline){const value=await state();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('Live Ablo check timed out');}
 try{
  assert.equal(first.workspace,second.workspace);
  const initial=await a.request({action:'create',id,title:'Synthetic live SDK check'}) as Snapshot;
  const edit=(text:string,clientID:string)=>({action:'submit',id,version:0,clientID,operationId:randomUUID(),steps:EditorState.create({schema,doc:schema.nodeFromJSON(initial.doc)}).tr.insertText(text,1).steps.map(step=>step.toJSON())});
  const requests=[edit('Alpha ','alice'),edit('Beta ','bob')],results=await Promise.all([a.request(requests[0]),b.request(requests[1])]) as {accepted:boolean}[];
  assert.equal(results.filter(result=>result.accepted).length,1);
  const accepted=results.findIndex(result=>result.accepted);assert.deepEqual(await a.request(requests[accepted]),results[accepted]);
  const send=(bridge:typeof a,clientID:string,text:string,agent:boolean)=>bridge.request({action:'chat-send',id,clientID,messageID:randomUUID(),text,agent});
  await Promise.all([send(a,'alice','append alpha',true),send(b,'bob','append beta',true)]);
  await Promise.all([send(a,'alice','Human alpha is here.',false),send(b,'bob','Human beta is here.',false)]);
  const complete=await waitFor(value=>!value.activeRuns&&value.messages.filter((message:any)=>message.kind==='assistant').length===2);
  for(const text of ['Human alpha is here.','Human beta is here.'])assert.ok(complete.messages.some((message:any)=>message.text===text));
  const doc=await a.request({action:'open',id}) as Snapshot,text=schema.nodeFromJSON(doc.doc).textContent;
  assert.equal(text.split('Agent alpha addition.').length-1,1);assert.equal(text.split('Agent beta addition.').length-1,1);
  assert.deepEqual(await b.request({action:'open',id}),doc);
  await Promise.all([send(a,'alice','wait for stop',true),send(b,'bob','wait for stop',true)]);
  assert.equal((await state()).activeRuns,2);
  await a.request({action:'chat-stop',id,clientID:'alice'});await waitFor(value=>!value.activeRuns);
 }finally{a.close();b.close();await first.close();await second.close();await rm(dir,{recursive:true,force:true});}
});
