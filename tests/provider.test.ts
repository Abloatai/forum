import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createAnthropic} from '@ai-sdk/anthropic';
import {createGateway} from 'ai';
import {hostedAgentConfiguration,runHostedAgent} from '../src/agent/hosted.js';
import {documentTool} from '../src/agent/tools.js';
import {schema,type Snapshot} from '../src/document/index.js';
import {openAuthority} from './fixtures/authority.js';

for(const kind of ['anthropic','gateway'] as const)test(kind+' SDK wire protocol executes the same guarded tools without exposing its credential',async()=>{
 const traceID=randomUUID(),events:unknown[]=[],key='synthetic-'+kind+'-credential',id=randomUUID(),authority=openAuthority(randomUUID());let calls=0;
 const fetcher:typeof fetch=async(_input,init)=>{
  calls++;const body=JSON.parse(String(init?.body));assert.doesNotMatch(JSON.stringify(body),new RegExp(key));
  assert.equal(new Headers(init?.headers).get(kind==='anthropic'?'x-api-key':'authorization'),kind==='anthropic'?key:'Bearer '+key);
  events.push({event:'model.request',body});
  if(calls===2)assert.match(JSON.stringify(body),/tool_result|tool-result/);
  if(calls===3)assert.match(JSON.stringify(body),/accepted/);
  const name=calls===1?'read_document':'append_paragraph',args=calls===1?{}:{version:0,text:'Protocol paragraph.'};
  const result=kind==='anthropic'?{
   id:'msg_fixture',type:'message',role:'assistant',model:'claude-fixture',stop_reason:calls<3?'tool_use':'end_turn',stop_sequence:null,
   content:calls<3?[{type:'tool_use',id:'call_'+calls,name,input:args}]:[{type:'text',text:'Added one paragraph.'}],usage:{input_tokens:10,output_tokens:5},
  }:{
   content:calls<3?[{type:'tool-call',toolCallId:'call_'+calls,toolName:name,input:JSON.stringify(args)}]:[{type:'text',text:'Added one paragraph.'}],
   finishReason:{unified:calls<3?'tool-calls':'stop',raw:calls<3?'tool_use':'end_turn'},usage:{inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:5,text:5,reasoning:0}},warnings:[],
  };
  events.push({event:'model.response',body:result});return Response.json(result);
 };
 const provider=kind==='anthropic'?createAnthropic({apiKey:key,fetch:fetcher}):createGateway({apiKey:key,fetch:fetcher});
 try{
  await authority.request({action:'create',id,title:'Synthetic SDK protocol check'});
  const answer=await runHostedAgent({provider,models:[{id:'fixture/model',name:'Fixture',isDefault:true}]},'Append one paragraph.',async(name,args)=>{
   const result=await documentTool(authority.request,id,'agent',name,args);events.push({event:'tool.result',name,args,result});return result;
  },new AbortController().signal,async()=>{});
  assert.equal(answer,'Added one paragraph.');assert.equal(calls,3);
  const snapshot=await authority.request({action:'open',id}) as Snapshot;assert.equal(snapshot.version,1);assert.equal(schema.nodeFromJSON(snapshot.doc).textContent,'Protocol paragraph.');
  if(process.env.FORUM_AGENT_TRACE_DIR){
   const directory=process.env.FORUM_AGENT_TRACE_DIR;await mkdir(directory,{recursive:true,mode:0o700});
   const serialized=JSON.stringify({traceID,simulated:true,provider:kind,events,answer},null,2);assert.ok(!serialized.includes(key));await writeFile(join(directory,kind+'.json'),serialized,{mode:0o600});
  }
 }finally{await authority.close();}
});

test('hosted provider configuration fails closed for partial or invalid model settings',()=>{
 const names=['FORUM_MODEL_PROVIDER','FORUM_MODEL_API_KEY','FORUM_MODELS'] as const,previous=names.map(name=>process.env[name]);
 try{
  for(const name of names)delete process.env[name];assert.equal(hostedAgentConfiguration(),undefined);
  process.env.FORUM_MODEL_PROVIDER='anthropic';assert.throws(hostedAgentConfiguration,/invalid_hosted_agent_configuration/);
  process.env.FORUM_MODEL_API_KEY='synthetic-configuration-key';
  for(const list of ['', 'same,same','invalid model','x'.repeat(121),Array.from({length:21},(_,i)=>'model-'+i).join(',')]){process.env.FORUM_MODELS=list;assert.throws(hostedAgentConfiguration,/invalid_hosted_agent_configuration/);}
  process.env.FORUM_MODELS='first,second';
  for(const kind of ['anthropic','gateway']){process.env.FORUM_MODEL_PROVIDER=kind;assert.deepEqual(hostedAgentConfiguration()!.models.map(model=>model.id),['first','second']);}
  process.env.FORUM_MODEL_PROVIDER='unconfigured-provider';assert.throws(hostedAgentConfiguration,/invalid_hosted_agent_provider/);
 }finally{names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];});}
});
