import {randomUUID} from 'node:crypto';
import {identifier,type Request} from '../document/index.js';
import {type actorClients,type Client} from '../ablo/index.js';
import {documentTool} from './tools.js';
import {runAgent,type AgentConfig} from './cli.js';

export function createChat(clients:ReturnType<typeof actorClients>,request:(input:Request,client:Client,runID?:string)=>Promise<unknown>,config?:AgentConfig){
  const owner=randomUUID(),running=new Map<string,{document:string;controller:AbortController;done:Promise<void>}>();
  const members=new Map<string,Map<string,{time:number;name:string}>>();
  async function add(client:Client,document:string,author:string,kind:string,text:string){
    await client.commits.create({operations:[{action:'create',model:'forumMessages',id:randomUUID(),data:{document,author,kind,text,sender:'',intent:'',time:Date.now()}}],idempotencyKey:randomUUID(),wait:'confirmed'});
  }
  async function chat(input:Request,client:Client,actor:string,name?:string):Promise<unknown>{
    identifier(input.id);identifier(input.clientID);await request({action:'open',id:input.id},client);
    const id=input.id,author=name??`Member ${input.clientID.slice(0,4)}`;
    if(input.action==='chat-state'){
      const now=Date.now(),present=members.get(id)??new Map<string,{time:number;name:string}>();present.set(actor,{time:now,name:author});
      for(const [key,value]of present)if(value.time<now-15_000)present.delete(key);members.set(id,present);
      const [messages,runs]=await Promise.all([client.forumMessages.list({where:{document:id},orderBy:{time:'desc',id:'desc'},limit:200}),client.forumRuns.list({where:{document:id},orderBy:{time:'desc'},limit:100})]);
      const active=runs.filter(run=>['running','stop_requested'].includes(run.status)&&run.time>Date.now()-210_000);
      const last=active[0]??runs[0];
      return {messages:[...messages].reverse(),run:last?{...last,status:['running','stop_requested'].includes(last.status)&&!active.includes(last)?'interrupted':last.status}:null,activeRuns:active.length,members:[...present.values()].map(value=>value.name),models:config?.models??[],agent:config?(config.scripted?'Scripted test agent':'Codex'):null};
    }
    if(input.action==='chat-stop'){
      const runs=await client.forumRuns.list({where:{document:id,status:'running'},limit:100});
      if(runs.length)await client.commits.create({operations:runs.map(run=>({action:'update' as const,model:'forumRuns',id:run.id,data:{status:'stop_requested'}})),idempotencyKey:randomUUID(),wait:'confirmed'});
      for(const run of running.values())if(run.document===id)run.controller.abort();return {ok:true};
    }
    if(input.action!=='chat-send')throw new Error('invalid_chat_action');identifier(input.messageID);
    if(typeof input.text!=='string'||!input.text.trim()||input.text.length>10_000||typeof input.agent!=='boolean')throw new Error('invalid_message');
    const sender=input.clientID,intent=JSON.stringify([input.text.trim(),input.agent,input.model??null]);
    async function previous(){const row=await client.forumMessages.read({id:input.messageID as string});if(row&&(row.document!==id||row.sender!==sender||row.intent!==intent))throw new Error('message_id_reused');return row;}
    if(await previous())return {ok:true};
    if(input.agent&&!config)throw new Error('Agent not configured. Send a team message or configure a dedicated Codex profile.');
    if(input.agent&&running.size>=4)throw new Error('Four agents are already running in this app. Wait or stop a run.');
    const model=typeof input.model==='string'?input.model:config?.model??config?.models?.find(model=>model.isDefault)?.id??config?.models?.[0]?.id;
    if(!config?.scripted&&input.agent&&!model)throw new Error('Model catalog unavailable. Check the dedicated Codex profile.');
    if(model&&!config?.models?.some(item=>item.id===model))throw new Error('model_not_allowed');
    const runID=randomUUID(),label=`${config?.scripted?'Scripted test agent':'Codex'} ${runID.slice(0,4)}`;
    try{await client.commits.create({operations:[
      {action:'create',model:'forumMessages',id:input.messageID,data:{document:id,author,kind:'user',text:input.text.trim(),sender,intent,time:Date.now()}},
      ...(input.agent?[{action:'create' as const,model:'forumRuns',id:runID,data:{document:id,author:label,status:'running',owner,time:Date.now()}}]:[]),
    ],idempotencyKey:`chat:${input.messageID}`,wait:'confirmed'});}catch(error){if(!await previous())throw error;if(!input.agent||!await client.forumRuns.read({id:runID}))return {ok:true};}
    if(!input.agent)return {ok:true};
    const controller=new AbortController(),agentClient=clients.get(`agent-${runID}`,true);
    const check=async()=>{const row=await agentClient.forumRuns.read({id:runID});if(!row||row.owner!==owner||row.status!=='running')controller.abort();if(controller.signal.aborted)throw new Error('stopped');};
    const timer=setInterval(()=>void check().catch(()=>controller.abort()),1000);
    const done=runAgent({...config!,model},input.text,async(name,args)=>{
      await check();
      try{const result=await documentTool(value=>request(value,agentClient,runID),id,`agent-${runID}`,name,args);await add(agentClient,id,label,'tool',`${name} completed`);return result;}
      catch(error){await add(agentClient,id,label,'tool',`${name} rejected; reread required`);throw error;}
    },controller.signal).then(async answer=>{await check();await add(agentClient,id,label,'assistant',answer);await agentClient.forumRuns.update({id:runID,data:{status:'completed'}});})
      .catch(async error=>{const stopped=controller.signal.aborted;await add(agentClient,id,label,'system',stopped?'Stopped. Edits already applied remain in the document.':String(error.message));await agentClient.forumRuns.update({id:runID,data:{status:stopped?'stopped':'failed'}});})
      .catch(()=>{/* A revoked or unavailable project cannot accept further run updates. */})
      .finally(async()=>{clearInterval(timer);running.delete(runID);await clients.release(`agent-${runID}`);});
    running.set(runID,{document:id,controller,done});return {ok:true};
  }
  return {request:chat,async close(){for(const run of running.values())run.controller.abort();await Promise.all([...running.values()].map(run=>run.done));}};
}
