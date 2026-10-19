import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EditorState} from '@tiptap/pm/state';
import {schema,defaultPaper,type Snapshot} from '../src/document/index.js';
import {documentTool} from '../src/agent/tools.js';
import {openAuthority,startServer} from './fixtures/authority.js';
import {connectBridge} from '../src/realtime/index.js';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test('agent naming and shared layouts persist independently of text history and reject stale names',async()=>{
 const documentID=randomUUID();
 const dir=await mkdtemp(join(tmpdir(),'docs-metadata-')),path=join(dir,'db.sqlite');let authority=openAuthority(path);
 try{
  const original=await authority.request({action:'create',id:documentID,title:'Untitled'}) as Snapshot;
  await documentTool(authority.request,documentID,'agent','rename_document',{version:0,expectedTitle:'Untitled',title:'  Project notes  '});
  await assert.rejects(()=>documentTool(authority.request,documentID,'agent','rename_document',{version:0,expectedTitle:'Untitled',title:'Overwrite'}),/stale_version/);
  await assert.rejects(()=>documentTool(authority.request,documentID,'agent','rename_document',{version:1,expectedTitle:'Project notes',title:'Overwrite'}),/stale_version/);
  await assert.rejects(()=>documentTool(authority.request,documentID,'agent','rename_document',{version:0,expectedTitle:'Project notes',title:' '}),/invalid_title/);
  await assert.rejects(()=>authority.request({action:'layout',id:documentID,layout:'unknown'}),/invalid_layout/);
  await authority.request({action:'layout',id:documentID,layout:'flow'});
  const paper={...defaultPaper,width:816,height:1056,marginLeft:72,marginRight:72};
  await documentTool(authority.request,documentID,'agent','configure_paper',{version:0,expectedPaper:defaultPaper,paper});
  await assert.rejects(()=>documentTool(authority.request,documentID,'agent','configure_paper',{version:0,expectedPaper:defaultPaper,paper}),/stale_version/);
  for(const invalid of [{...paper,width:0},{...paper,marginLeft:800},{...paper,height:NaN},{...paper,extra:1}])await assert.rejects(()=>documentTool(authority.request,documentID,'agent','configure_paper',{version:0,expectedPaper:paper,paper:invalid}),/invalid_paper/);
  const changes=await authority.request({action:'changes',id:documentID,version:0}) as any;
  assert.equal(changes.title,'Project notes');assert.equal(changes.layout,'flow');assert.deepEqual(changes.steps,[]);
  await authority.close();authority=openAuthority(path);
  const reopened=await authority.request({action:'open',id:documentID}) as Snapshot;
  assert.equal(reopened.title,'Project notes');assert.equal(reopened.layout,'flow');assert.equal(reopened.version,original.version);assert.deepEqual(reopened.doc,original.doc);
  assert.deepEqual(reopened.paper,paper);
 }finally{await authority.close();await rm(dir,{recursive:true,force:true});}
});
test('agent tools reject stale edits, preserve marks, and commit through document history',async()=>{
 const documentID=randomUUID();
 const dir=await mkdtemp(join(tmpdir(),'docs-agent-tools-')),authority=openAuthority(join(dir,'db.sqlite'));
 try{
  await authority.request({action:'create',id:documentID,title:'Tools'});
  await documentTool(authority.request,documentID,'agent','append_paragraph',{version:0,text:'A small document.'});
  const snap=await authority.request({action:'open',id:documentID}) as Snapshot;
  const state=EditorState.create({schema,doc:schema.nodeFromJSON(snap.doc)}),tr=state.tr.insertText('Human ',3).addMark(3,9,schema.marks.bold.create());
  await authority.request({action:'submit',id:documentID,clientID:'human',version:snap.version,operationId:randomUUID(),steps:tr.steps.map(s=>s.toJSON())});
  await assert.rejects(()=>documentTool(authority.request,documentID,'agent','replace_text',{version:snap.version,find:'A small document.',text:'Oops'}),/stale_version/);
  const fresh=await authority.request({action:'open',id:documentID}) as Snapshot;
  await documentTool(authority.request,documentID,'agent','replace_text',{version:fresh.version,find:'small',text:'focused'});
  const final=await authority.request({action:'open',id:documentID}) as Snapshot;
  assert.match(schema.nodeFromJSON(final.doc).textContent,/Human A focused document/);assert.match(JSON.stringify(final.doc),/bold/);
  await assert.rejects(()=>documentTool(authority.request,documentID,'agent','replace_text',{version:final.version,find:'missing',text:'Oops'}),/text_not_unique/);
 }finally{await authority.close();await rm(dir,{recursive:true,force:true});}
});
test('shared chat, authenticated MCP process, human concurrent edit, stop, persistence and idempotent retry',async()=>{
 const documentID=randomUUID();
 const dir=await mkdtemp(join(tmpdir(),'docs-agent-chat-')),database=join(dir,'db.sqlite'),token='synthetic-agent-test-'.repeat(3);
 let server=await startServer({database,token,agent:{command:resolve('tests/fixtures/agent.mjs'),home:dir,scripted:true}}),a=connectBridge(server.url,token),b=connectBridge(server.url,token);
 const state=()=>b.request({action:'chat-state',id:documentID,clientID:'bob'}) as Promise<any>;
 async function waitFor(predicate:(value:any)=>boolean){for(let i=0;i<100;i++){const value=await state();if(predicate(value))return value;await sleep(50);}throw new Error('Timed out');}
 try{
  await a.request({action:'create',id:documentID,title:'Shared'});
  const snap=await a.request({action:'open',id:documentID}) as Snapshot;
  const tr=EditorState.create({schema,doc:schema.nodeFromJSON(snap.doc)}).tr.insertText('A small document.',1);
  await a.request({action:'submit',id:documentID,version:0,clientID:'alice',operationId:randomUUID(),steps:tr.steps.map(s=>s.toJSON())});
  const message={action:'chat-send',id:documentID,clientID:'alice',messageID:randomUUID(),text:'Focus this sentence',agent:true};
  await a.request(message);await a.request(message);
  await waitFor(s=>s.messages.some((m:any)=>m.text==='read_document completed'));
  const current=await b.request({action:'open',id:documentID}) as Snapshot;
  const edit=EditorState.create({schema,doc:schema.nodeFromJSON(current.doc)}).tr.insertText(' Human addition.',18);
  await b.request({action:'submit',id:documentID,version:current.version,clientID:'bob',operationId:randomUUID(),steps:edit.steps.map(s=>s.toJSON())});
  const completed=await waitFor(s=>s.run?.status==='completed');
  assert.equal(completed.messages.filter((m:any)=>m.kind==='user').length,1);assert.ok(completed.messages.some((m:any)=>m.text.includes('rejected')));
  assert.equal(completed.agent,'Scripted test agent');
  const doc=await a.request({action:'open',id:documentID}) as Snapshot;assert.equal(schema.nodeFromJSON(doc.doc).textContent,'A focused document. Human addition.');
  await a.request({action:'chat-send',id:documentID,clientID:'alice',messageID:randomUUID(),text:'wait for stop',agent:true});
  await a.request({action:'chat-stop',id:documentID,clientID:'alice'});await waitFor(s=>s.run?.status==='stopped');
  a.close();b.close();await server.close();server=await startServer({database,token,agent:null});a=connectBridge(server.url,token);b=connectBridge(server.url,token);
  assert.ok((await state()).messages.some((m:any)=>m.kind==='assistant'));
  await assert.rejects(a.request({action:'chat-send',id:documentID,clientID:'alice',messageID:randomUUID(),text:'No configured agent',agent:true}),/not configured/);
 }finally{a.close();b.close();await server.close();await rm(dir,{recursive:true,force:true});}
});
test('two agent sessions and two humans share one document and transcript without overwriting additions',async()=>{
 const documentID=randomUUID(),dir=await mkdtemp(join(tmpdir(),'forum-multi-agent-')),token='synthetic-multi-agent-'.repeat(3);
 const server=await startServer({database:join(dir,'unused'),token,agent:{command:resolve('tests/fixtures/agent.mjs'),home:dir,scripted:true}}),a=connectBridge(server.url,token),b=connectBridge(server.url,token);
 try{
  await a.request({action:'create',id:documentID,title:'Two agents'});
  const send=(bridge:typeof a,clientID:string,text:string,agent:boolean)=>bridge.request({action:'chat-send',id:documentID,clientID,messageID:randomUUID(),text,agent});
  await Promise.all([send(a,'alice','append alpha',true),send(b,'bob','append beta',true)]);
  await Promise.all([send(a,'alice','Human alpha is here.',false),send(b,'bob','Human beta is here.',false)]);
  let final:any;
  for(let i=0;i<100;i++){final=await b.request({action:'chat-state',id:documentID,clientID:'bob'});if(!final.activeRuns&&final.messages.filter((m:any)=>m.kind==='assistant').length===2)break;await sleep(100);}
  assert.equal(final.activeRuns,0);assert.equal(final.messages.filter((m:any)=>m.kind==='assistant').length,2);
  const doc=await a.request({action:'open',id:documentID}) as Snapshot,text=schema.nodeFromJSON(doc.doc).textContent;
  assert.equal(text.split('Agent alpha addition.').length-1,1);assert.equal(text.split('Agent beta addition.').length-1,1);
  for(const line of ['Human alpha is here.','Human beta is here.'])assert.ok(final.messages.some((m:any)=>m.text===line));
  assert.equal(new Set(final.messages.filter((m:any)=>m.kind==='assistant').map((m:any)=>m.author)).size,2);
  await Promise.all([send(a,'alice','wait for stop',true),send(b,'bob','wait for stop',true)]);
  const both=await a.request({action:'chat-state',id:documentID,clientID:'alice'}) as any;assert.equal(both.activeRuns,2);
  await b.request({action:'chat-stop',id:documentID,clientID:'bob'});
  for(let i=0;i<100;i++){final=await b.request({action:'chat-state',id:documentID,clientID:'bob'});if(!final.activeRuns)break;await sleep(100);}
  assert.equal(final.activeRuns,0);
 }finally{a.close();b.close();await server.close();await rm(dir,{recursive:true,force:true});}
});
