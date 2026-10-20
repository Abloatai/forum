// Real model + hosted Ablo check. Run only against a disposable test branch.
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {wrapLanguageModel} from 'ai';
import {EditorState} from '@tiptap/pm/state';
import {Step} from '@tiptap/pm/transform';
import {collab,getVersion,receiveTransaction,sendableSteps} from 'prosemirror-collab';
import {hostedAgentConfiguration,type HostedAgentConfig} from '../src/agent/hosted.js';
import {openAuthority} from '../src/server/index.js';
import {actorClients} from '../src/ablo/index.js';
import {schema,type Snapshot,type Changes,type Request} from '../src/document/index.js';

const branch=process.env.FORUM_LIVE_TEST_BRANCH;
if(!branch?.startsWith('br_')||!process.env.ABLO_API_KEY||!process.env.FORUM_AGENT_TRACE_DIR)throw Error('Set a disposable test branch key, FORUM_LIVE_TEST_BRANCH, and private FORUM_AGENT_TRACE_DIR.');
const base=hostedAgentConfiguration();if(!base)throw Error('Hosted model configuration required.');
const traceID=randomUUID(),events:unknown[]=[],directory=resolve(process.env.FORUM_AGENT_TRACE_DIR);await mkdir(directory,{recursive:true,mode:0o700});
const clients=actorClients();assert.ok((await clients.workspace()).endsWith(':'+branch),'Refuse to write outside the explicitly selected disposable branch.');
let notifyProvider:(()=>void)|undefined;
const readers=new Set<string>();let notifyReaders!:()=>void,releaseReaders!:()=>void;
const readersReady=new Promise<void>(resolve=>notifyReaders=resolve),readersReleased=new Promise<void>(resolve=>releaseReaders=resolve);
function results(prompt:any[]){return prompt.flatMap(message=>message.role==='tool'?message.content:[]).filter(part=>part.type==='tool-result');}
const work:Promise<void>[]=[],makeConfig=(model:string):HostedAgentConfig=>({...base,model,waitUntil:p=>work.push(p),provider:id=>{const model=base.provider(id);if(typeof model==='string'||model.specificationVersion!=='v3')throw Error('Live trace requires a V3 provider.');return wrapLanguageModel({model,middleware:{specificationVersion:'v3',wrapGenerate:async({params,doGenerate})=>{
 if(!readers.has(id)&&results(params.prompt).some(part=>part.toolName==='read_document'&&part.output.type==='json')){
  readers.add(id);events.push({event:'schedule.pause-after-read',model:id});if(readers.size===2)notifyReaders();
  await readersReleased;
 }
 notifyProvider?.();notifyProvider=undefined;events.push({event:'model.request',model:id,prompt:params.prompt,tools:params.tools});
 try{const result=await doGenerate();events.push({event:'model.response',model:id,content:result.content,usage:result.usage,finishReason:result.finishReason});return result;}
 catch(error){events.push({event:'model.error',model:id,name:(error as Error).name,status:(error as {statusCode?:number}).statusCode??null});throw error;}
}}});}});
const firstModel=base.models[0].id,secondModel=base.models.find(model=>model.id.split('/')[0]!==firstModel.split('/')[0])?.id??base.models[1]?.id??firstModel;
assert.notEqual(firstModel,secondModel,'Configure two distinct real models for this check.');
const a=openAuthority(makeConfig(firstModel),clients,'synthetic-live-agent-team'),b=openAuthority(makeConfig(secondModel),actorClients(),'synthetic-live-agent-team');
const id=randomUUID(),human='Human alpha ',otherHuman='Human beta ',alpha='A focused shared draft.',beta='Agent beta addition.';
const text=async()=>schema.nodeFromJSON((await a.request({action:'open',id}) as Snapshot).doc).textContent;
async function send(authority:typeof a,clientID:string,message:string,model:string,messageID=randomUUID()){
 const input={action:'chat-send',id,clientID,messageID,text:message,agent:true,model};events.push({event:'user.request',clientID,input});await authority.request(input,clientID,clientID);return input;
}
// Real ProseMirror clients keep unconfirmed steps while the hosted agents work.
function humanClient(snapshot:Snapshot,clientID:string,authority:typeof a){
 let state=EditorState.create({schema,doc:schema.nodeFromJSON(snapshot.doc),plugins:[collab({version:snapshot.version,clientID})]});
 return {
  get state(){return state;},
  insert(text:string,bold=false){let tr=state.tr.insertText(text,1);if(bold)tr=tr.addMark(1,text.length+1,schema.marks.bold.create());state=state.apply(tr);},
  request():Request{const pending=sendableSteps(state)!;return {action:'submit',id,version:pending.version,clientID:pending.clientID,operationId:randomUUID(),steps:pending.steps.map(step=>step.toJSON())};},
  async pull(){const changes=await authority.request({action:'changes',id,version:getVersion(state)}) as Changes;state=state.apply(receiveTransaction(state,changes.steps.map(step=>Step.fromJSON(schema,step)),changes.clientIDs));},
 };
}
try{
 await a.request({action:'create',id,title:'Synthetic real provider multiplayer check'});
 const empty=await a.request({action:'open',id}) as Snapshot;
 const seed=EditorState.create({schema,doc:schema.nodeFromJSON(empty.doc)}).tr.insertText('An initial shared draft.',1);
 await a.request({action:'submit',id,version:0,clientID:'seed',operationId:randomUUID(),steps:seed.steps.map(step=>step.toJSON())});
 const initial=await a.request({action:'open',id}) as Snapshot;
 const left=humanClient(initial,'human-alpha',a),right=humanClient(initial,'human-beta',b);
 left.insert(human,true);right.insert(otherHuman);
 const [input]=await Promise.all([
  send(a,'human-alpha',`Read this document. Replace the unique text "An initial shared draft." with "${alpha}". Preserve all other content and formatting. If stale, read again and retry.`,firstModel),
  send(b,'human-beta',`Read this document. Append exactly one paragraph containing only "${beta}". Preserve all other content. If stale, read again and retry.`,secondModel),
 ]);
 await Promise.race([readersReady,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Both real agents must read before the scheduled human edit')),45000);timer.unref();})]);
 const accepted=await a.request(left.request());assert.equal((accepted as any).accepted,true);
 const rejected=await b.request(right.request());assert.equal((rejected as any).accepted,false,'Same-version competing human edit must be rejected before OT rebasing.');
 events.push({event:'human.concurrent-commit',accepted,rejected,clientVersion:initial.version});
 releaseReaders();
 await Promise.all([
  a.request({action:'chat-send',id,clientID:'human-alpha',messageID:randomUUID(),text:'Human alpha is here.',agent:false},'human-alpha'),
  b.request({action:'chat-send',id,clientID:'human-beta',messageID:randomUUID(),text:'Human beta is here.',agent:false},'human-beta'),
 ]);
 await a.request({...input,clientID:'human-alpha'},'human-alpha','human-alpha');
 await Promise.all(work);
 // Rebase the second human's pending same-paragraph edit over both agents.
 await right.pull();const rebased=right.request();assert.equal((await b.request(rebased) as any).accepted,true);
 const beforeRetry=await b.request({action:'open',id}) as Snapshot;
 assert.equal((await a.request(rebased) as any).accepted,true);
 assert.equal((await a.request({action:'open',id}) as Snapshot).version,beforeRetry.version,'Replaying the accepted OT batch must not apply it twice.');
 await left.pull();await right.pull();
 assert.equal(sendableSteps(left.state),null);assert.equal(sendableSteps(right.state),null);
 assert.deepEqual(left.state.doc.toJSON(),right.state.doc.toJSON());
 assert.deepEqual((await a.request({action:'open',id}) as Snapshot).doc,right.state.doc.toJSON());
 assert.deepEqual(await a.request({action:'open',id}),await b.request({action:'open',id}));
 let markedHuman=false;right.state.doc.descendants(node=>{if(node.isText&&node.text?.includes(human)&&node.marks.some(mark=>mark.type.name==='bold'))markedHuman=true;});assert.ok(markedHuman,'Human formatting must survive agent edits and OT rebasing.');
 const state=await a.request({action:'chat-state',id,clientID:'human'}) as any,final=await text();
 events.push({event:'ot.converged',version:beforeRetry.version,doc:right.state.doc.toJSON(),pendingSteps:0});
 const failures=events.filter((event:any)=>event.event==='model.error') as {model:string;status:number|null}[];
 if(failures.length){events.push({event:'verification',passed:false,document:id,finalText:final});throw Error('Live provider failed: '+failures.map(error=>`${error.model} HTTP ${error.status??'unknown'}`).join(', ')+'. Inspect the private trace; this is not a passing model check.');}
 assert.equal(state.activeRuns,0);assert.equal(state.messages.filter((m:any)=>m.kind==='assistant').length,2,JSON.stringify(state.messages.filter((m:any)=>m.kind==='system')));
 for(const value of [alpha,beta,human,otherHuman])assert.equal(final.split(value).length-1,1,final);
 assert.equal(state.messages.filter((m:any)=>m.kind==='user').length,4,'Retry must not start a duplicate run.');
 assert.ok(events.some((event:any)=>event.event==='model.response'&&event.content.some((part:any)=>part.type==='tool-call'&&part.toolName==='read_document')));
 for(const message of ['Human alpha is here.','Human beta is here.'])assert.equal(state.messages.filter((m:any)=>m.text===message).length,1);
 const requests=events.filter((event:any)=>event.event==='model.request') as any[];
 for(const model of [firstModel,secondModel]){
  const own=requests.filter(event=>event.model===model);
  const staleAt=own.findIndex(event=>results(event.prompt).some(part=>part.output.type==='error-text'&&part.output.value.startsWith('stale_version')));
  assert.ok(staleAt>=0,model+' must encounter the scheduled stale-version rejection.');
  assert.ok(own.slice(staleAt+1).some(event=>results(event.prompt).some(part=>part.toolName==='read_document'&&part.output.type==='json'&&part.output.value.version>initial.version)),model+' must reread newer authoritative content.');
 }
 // Wait for actual generation, then stop from another authority and retain accepted edits.
 const generating=new Promise<void>(resolve=>notifyProvider=resolve);await send(a,'human-stop','Read the document, then append 50 paragraphs about writing together.',firstModel);
 await Promise.race([generating,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Provider did not start')),15000);timer.unref();})]);
 await b.request({action:'chat-stop',id,clientID:'human-stop'});const stoppedText=await text();await Promise.all(work);
 assert.equal(await text(),stoppedText);const stopped=await a.request({action:'chat-state',id,clientID:'human-stop'}) as any;assert.equal(stopped.run.status,'stopped');
 events.push({event:'verification',passed:true,document:id,finalText:final,models:[firstModel,secondModel]});
 console.log(JSON.stringify({passed:true,traceID,models:[firstModel,secondModel],checks:['two real agents with forced stale-read recovery','two human OT clients converge with agent edits','same-paragraph pending edit and bold formatting retained','idempotent OT and chat retries','two humans share chat','cross-authority stop'],directory}));
}finally{
 releaseReaders();
 await a.close();await b.close();
 // Fixture text only; never persist credentials, provider headers or request options.
 const serialized=JSON.stringify({traceID,branch,events},null,2);if([process.env.FORUM_MODEL_API_KEY,process.env.ABLO_API_KEY].some(key=>key&&serialized.includes(key)))throw Error('Refuse trace containing a credential');
 await writeFile(resolve(directory,'trace.json'),serialized,{mode:0o600});
}
