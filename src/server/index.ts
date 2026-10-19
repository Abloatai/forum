import {createHash,randomUUID} from 'node:crypto';
import {Step} from '@tiptap/pm/transform';
import {schema,emptyDocument,identifier,validateRequest,defaultPaper,paperSettings,type Snapshot,type Request} from '../document/index.js';
import {actorClients,type Client} from '../ablo/index.js';
import {createChat} from '../agent/index.js';
import {discoverModels} from '../agent/models.js';
import {agentConfiguration,type AgentConfig} from '../agent/cli.js';
import {startBridge} from '../realtime/index.js';

function snapshot(row:{id:string;title:string;doc:string;version:number;layout:string;paper:string}):Snapshot{
  return {id:row.id,title:row.title,doc:JSON.parse(row.doc),version:row.version,layout:row.layout as 'page'|'flow',paper:paperSettings(JSON.parse(row.paper))};
}
function stale(error:unknown){return !!error&&typeof error==='object'&&'code'in error&&error.code==='stale_context';}
export function openAuthority(agent?:AgentConfig,clients=actorClients(),workspace='local'){
  async function documentRequest(input:Request,client:Client,runID?:string):Promise<unknown>{
    validateRequest(input);
    if(input.action==='list')return (await client.forumDocuments.list({where:{workspace},limit:1000,orderBy:{time:'desc',id:'desc'}})).map(({id,title,version})=>({id,title,version}));
    identifier(input.id);
    if(input.action==='create'){
      if(typeof input.title!=='string'||!input.title.trim()||input.title.length>120)throw new Error('invalid_title');
      const existing=await client.forumDocuments.read({id:input.id});if(existing){if(existing.workspace!==workspace)throw new Error('document_not_found');return snapshot(existing);}
      await client.commits.create({operations:[{action:'create',model:'forumDocuments',id:input.id,data:{workspace,time:Date.now(),title:input.title.trim(),doc:JSON.stringify(emptyDocument),version:0,layout:'page',paper:JSON.stringify(defaultPaper)}}],idempotencyKey:`create:${input.id}`,wait:'confirmed'});
      return documentRequest({action:'open',id:input.id},client);
    }
    const row=await client.forumDocuments.read({id:input.id});if(!row||row.workspace!==workspace)throw new Error('document_not_found');
    const current=snapshot(row);
    const run=runID?await client.forumRuns.read({id:runID}):null;
    if(runID&&(!run||run.status!=='running'||run.document!==row.id||run.time<Date.now()-210_000))throw new Error('stopped');
    const reads=run?[row,run]:[row];
    if(input.action==='open')return current;
    if(['paper','layout','rename'].includes(input.action)){
      let data:Record<string,string>;
      if(input.action==='paper'){
        const paper=paperSettings(input.paper),expected=paperSettings(input.expectedPaper);
        if(input.version!==current.version||JSON.stringify(expected)!==JSON.stringify(current.paper))throw new Error('stale_version: read_document again before configuring paper');
        data={paper:JSON.stringify(paper)};
      }else if(input.action==='rename'){
        if(typeof input.title!=='string'||!input.title.trim()||input.title.length>120)throw new Error('invalid_title');
        if(input.expectedTitle!==current.title||input.version!==current.version)throw new Error('stale_version: read_document again before naming');
        data={title:input.title.trim()};
      }else{if(!['page','flow'].includes(String(input.layout)))throw new Error('invalid_layout');data={layout:input.layout as string};}
      try{await client.commits.create({operations:[{action:'update',model:'forumDocuments',id:row.id,data}],reads,idempotencyKey:randomUUID(),wait:'confirmed'});}catch(error){if(stale(error))throw new Error('stale_version: read_document again');throw error;}
      return {...current,...data,...(data.paper?{paper:JSON.parse(data.paper)}:{})};
    }
    if(!Number.isSafeInteger(input.version)||(input.version as number)<0||(input.version as number)>current.version)throw new Error('invalid_version');
    const from=input.version as number;
    if(input.action==='changes'){
      const rows=await client.forumSteps.list({where:[['document','=',row.id],['version','>',from],['version','<=',current.version]],orderBy:{version:'asc'},limit:256});
      if(rows.some((step,index)=>step.version!==from+index+1))throw new Error('incomplete_history');
      return {title:row.title,layout:row.layout,paper:current.paper,version:from+rows.length,steps:rows.map(r=>JSON.parse(r.step)),clientIDs:rows.map(r=>r.client)};
    }
    identifier(input.operationId);identifier(input.clientID);
    const digest=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    async function receipt(){const row=await client.forumReceipts.read({id:input.operationId as string});if(!row)return null;if(row.digest!==digest)throw new Error('operation_id_reused');return JSON.parse(row.result);}
    const previous=await receipt();if(previous)return previous;
    if(from!==current.version)return {accepted:false,version:current.version};
    if(!Array.isArray(input.steps)||!input.steps.length||input.steps.length>256)throw new Error('invalid_steps');
    let doc=schema.nodeFromJSON(current.doc);
    for(const json of input.steps){const applied=Step.fromJSON(schema,json).apply(doc);if(applied.failed||!applied.doc)throw new Error('invalid_step');doc=applied.doc;doc.check();}
    if(JSON.stringify(doc.toJSON()).length>2_000_000)throw new Error('document_too_large');
    const result={accepted:true,version:from+input.steps.length};
    // shortcut: retain OT history for offline rebasing; compact only with acknowledged client horizons.
    try{
      await client.commits.create({operations:[
        {action:'update',model:'forumDocuments',id:row.id,data:{doc:JSON.stringify(doc.toJSON()),version:result.version}},
        ...input.steps.map((step,index)=>({action:'create' as const,model:'forumSteps',id:randomUUID(),data:{document:row.id,version:from+index+1,step:JSON.stringify(step),client:input.clientID as string}})),
        {action:'create',model:'forumReceipts',id:input.operationId,data:{digest,result:JSON.stringify(result)}},
      ],reads,idempotencyKey:input.operationId,wait:'confirmed'});
    }catch(error){const recovered=await receipt();if(recovered)return recovered;if(stale(error))return {accepted:false,version:current.version};throw error;}
    return result;
  }
  const chat=createChat(clients,documentRequest,agent);
  return {async request(input:Request,actor='local',name?:string){validateRequest(input);const client=clients.get(actor);return input.action.startsWith('chat-')?chat.request(input,client,actor,name):documentRequest(input,client);},release:clients.release,workspace:clients.workspace,async close(){await chat.close();await clients.close();}};
}
export async function startServer(options:{token:string;host?:string;port?:number;agent?:AgentConfig|null;clients?:ReturnType<typeof actorClients>}){
  const agent=options.agent===undefined?agentConfiguration():options.agent??undefined;
  if(agent&&!agent.scripted)agent.models=await discoverModels(agent).catch(()=>[]);
  const authority=openAuthority(agent,options.clients);
  try{const workspace=await authority.workspace();const bridge=await startBridge({host:options.host??'127.0.0.1',port:options.port??0,token:options.token,request:authority.request,release:authority.release});return {workspace,url:`ws://127.0.0.1:${(bridge.address as {port:number}).port}`,async close(){await bridge.close();await authority.close();}};}
  catch(error){await authority.close();throw error;}
}
