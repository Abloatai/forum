// Real model + hosted Ablo check. Run only against a disposable test branch.
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {wrapLanguageModel} from 'ai';
import {hostedAgentConfiguration,type HostedAgentConfig} from '../src/agent/hosted.js';
import {openAuthority} from '../src/server/index.js';
import {actorClients} from '../src/ablo/index.js';
import {schema,type Snapshot} from '../src/document/index.js';
import {documentTool} from '../src/agent/tools.js';

const branch=process.env.FORUM_LIVE_TEST_BRANCH;
if(!branch?.startsWith('br_')||!process.env.ABLO_API_KEY||!process.env.FORUM_AGENT_TRACE_DIR)throw Error('Set a disposable test branch key, FORUM_LIVE_TEST_BRANCH, and private FORUM_AGENT_TRACE_DIR.');
const base=hostedAgentConfiguration();if(!base)throw Error('Hosted model configuration required.');
const traceID=randomUUID(),events:unknown[]=[],directory=resolve(process.env.FORUM_AGENT_TRACE_DIR);await mkdir(directory,{recursive:true,mode:0o700});
const clients=actorClients();assert.ok((await clients.workspace()).endsWith(':'+branch),'Refuse to write outside the explicitly selected disposable branch.');
let notifyProvider:(()=>void)|undefined;
const work:Promise<void>[]=[],makeConfig=(model:string):HostedAgentConfig=>({...base,model,waitUntil:p=>work.push(p),provider:id=>{const model=base.provider(id);if(typeof model==='string'||model.specificationVersion!=='v3')throw Error('Live trace requires a V3 provider.');return wrapLanguageModel({model,middleware:{specificationVersion:'v3',wrapGenerate:async({params,doGenerate})=>{
 notifyProvider?.();notifyProvider=undefined;events.push({event:'model.request',model:id,prompt:params.prompt,tools:params.tools});
 const result=await doGenerate();events.push({event:'model.response',model:id,content:result.content,usage:result.usage,finishReason:result.finishReason});return result;
}}});}});
const firstModel=base.models[0].id,secondModel=base.models.find(model=>model.id.split('/')[0]!==firstModel.split('/')[0])?.id??base.models[1]?.id??firstModel;
const a=openAuthority(makeConfig(firstModel),clients,'synthetic-live-agent-team'),b=openAuthority(makeConfig(secondModel),actorClients(),'synthetic-live-agent-team');
const id=randomUUID(),human='Human addition must stay.',alpha='Agent alpha addition.',beta='Agent beta addition.';
const text=async()=>schema.nodeFromJSON((await a.request({action:'open',id}) as Snapshot).doc).textContent;
async function send(authority:typeof a,clientID:string,message:string,model:string,messageID=randomUUID()){
 const input={action:'chat-send',id,clientID,messageID,text:message,agent:true,model};events.push({event:'user.request',clientID,input});await authority.request(input,clientID,clientID);return input;
}
try{
 await a.request({action:'create',id,title:'Synthetic real provider multiplayer check'});
 await documentTool(input=>a.request(input),id,'human','append_paragraph',{version:0,text:'An initial shared draft.'});
 const [input]=await Promise.all([
  send(a,'human-alpha',`Read this document. Append exactly one paragraph containing only "${alpha}". Preserve all other content. If stale, read again and retry.`,firstModel),
  send(b,'human-beta',`Read this document. Append exactly one paragraph containing only "${beta}". Preserve all other content. If stale, read again and retry.`,secondModel),
 ]);
 for(let attempt=0;;attempt++){const current=await a.request({action:'open',id}) as Snapshot;try{await documentTool(input=>a.request(input),id,'human','append_paragraph',{version:current.version,text:human});break;}catch(error){if(attempt>=3||!(error as Error).message.startsWith('stale_version'))throw error;}}
 await a.request({...input,clientID:'human-alpha'},'human-alpha','human-alpha');
 await Promise.all(work);
 const state=await a.request({action:'chat-state',id,clientID:'human'}) as any,final=await text();
 assert.equal(state.activeRuns,0);assert.equal(state.messages.filter((m:any)=>m.kind==='assistant').length,2,JSON.stringify(state.messages.filter((m:any)=>m.kind==='system')));
 for(const value of [alpha,beta,human])assert.equal(final.split(value).length-1,1,final);
 assert.equal(state.messages.filter((m:any)=>m.kind==='user').length,2,'Retry must not start a duplicate run.');
 assert.ok(events.some((event:any)=>event.event==='model.response'&&event.content.some((part:any)=>part.type==='tool-call'&&part.toolName==='read_document')));
 // Wait for actual generation, then stop from another authority and retain accepted edits.
 const generating=new Promise<void>(resolve=>notifyProvider=resolve);await send(a,'human-stop','Read the document, then append 50 paragraphs about writing together.',firstModel);
 await Promise.race([generating,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Provider did not start')),15000);timer.unref();})]);
 await b.request({action:'chat-stop',id,clientID:'human-stop'});const stoppedText=await text();await Promise.all(work);
 assert.equal(await text(),stoppedText);const stopped=await a.request({action:'chat-state',id,clientID:'human-stop'}) as any;assert.equal(stopped.run.status,'stopped');
 events.push({event:'verification',passed:true,document:id,finalText:final,models:[firstModel,secondModel]});
 console.log(JSON.stringify({passed:true,traceID,models:[firstModel,secondModel],checks:['two real agents','concurrent human edit retained','version-guarded tools','idempotent retry','shared transcript','cross-authority stop'],directory}));
}finally{
 await a.close();await b.close();
 // Fixture text only; never persist credentials, provider headers or request options.
 const serialized=JSON.stringify({traceID,branch,events},null,2);if(serialized.includes(process.env.FORUM_MODEL_API_KEY!))throw Error('Refuse trace containing provider credential');
 await writeFile(resolve(directory,'trace.json'),serialized,{mode:0o600});
}
