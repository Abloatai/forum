// Real hosted Ablo, native authorities and ProseMirror clients. No model calls.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {actorClients} from '../src/ablo/index.js';
import {startServer} from '../src/server/index.js';
import {connectBridge} from '../src/realtime/index.js';
import {concurrentEditors} from './fixtures/concurrent-editors.js';
const branch=process.env.FORUM_LIVE_TEST_BRANCH,directory=process.env.FORUM_AGENT_TRACE_DIR;
if(!branch||!/^br_(?!root_)[a-z0-9]+$/.test(branch)||!process.env.ABLO_API_KEY||!directory)throw Error('Set a disposable branch key, FORUM_LIVE_TEST_BRANCH, and private FORUM_AGENT_TRACE_DIR.');
const traceID=randomUUID(),events:unknown[]=[],evidence:Record<string,unknown>={traceID,branch,realHostedAblo:true,events},actors=actorClients();
try{assert.ok((await actors.workspace()).endsWith(':'+branch),'Refuse another branch.');}finally{await actors.close();}
const token='synthetic-live-concurrency-'.repeat(3),servers:Awaited<ReturnType<typeof startServer>>[]=[],bridges:ReturnType<typeof connectBridge>[]=[];
try{
 for(let i=0;i<3;i++)servers.push(await startServer({token,agent:null}));
 for(let i=0;i<12;i++)bridges.push(connectBridge(servers[i%servers.length].url,token));
 let sequence=0;
 const observed=bridges.map((bridge,client)=>({...bridge,request:async(input:Parameters<typeof bridge.request>[0])=>{
  const request=++sequence,started=Date.now();events.push({event:'request',request,client,action:input.action,version:input.version,operationId:input.operationId});
  try{const result=await bridge.request(input) as {accepted?:boolean;version?:number};events.push({event:'response',request,durationMs:Date.now()-started,accepted:result.accepted,version:result.version});return result;}
  catch(error){events.push({event:'error',request,durationMs:Date.now()-started,code:(error as {code?:string}).code});throw error;}
 }}));
 const result=await concurrentEditors(observed,4);Object.assign(evidence,{passed:true,...result});
 const {doc,...summary}=result;console.log(JSON.stringify({passed:true,traceID,...summary,authorities:servers.length}));
}catch(error){evidence.passed=false;evidence.failure={name:(error as Error).name,code:(error as {code?:string}).code};throw error;}
finally{
 for(const bridge of bridges)bridge.close();await Promise.all(servers.map(server=>server.close()));
 await mkdir(directory,{recursive:true,mode:0o700});
 const serialized=JSON.stringify(evidence,null,2);assert.ok(!serialized.includes(process.env.ABLO_API_KEY!));
 await writeFile(resolve(directory,'concurrency.json'),serialized,{mode:0o600});
}
