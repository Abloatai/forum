// Coding codex-account model/list contract; only public model metadata crosses IPC.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import type {AgentConfig} from './cli.js';
export type Model={id:string;name:string;isDefault:boolean};
export function safeModels(value:unknown,allowed?:string[]):Model[]{
  const data=(value as {data?:unknown})?.data;
  if(!Array.isArray(data))throw new Error('model_catalog_unavailable');
  return data.slice(0,100).flatMap(model=>{
    if(typeof model?.model!=='string'||!model.model||model.model.length>200||typeof model.displayName!=='string'||model.displayName.length>200||typeof model.isDefault!=='boolean')return [];
    if(allowed && !allowed.includes(model.model))return [];
    return [{id:model.model,name:model.displayName,isDefault:model.isDefault}];
  });
}
export async function discoverModels(config:AgentConfig):Promise<Model[]>{
  if('provider'in config)return config.models;
  // Scripted fixtures have no model provider and must not advertise invented models.
  if(config.scripted)return [];
  const child=spawn(config.command,['--ignore-user-config','-c','analytics.enabled=false','app-server'],{cwd:config.home,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH??'',CODEX_HOME:config.home,LANG:'en_US.UTF-8'}});
  const lines=createInterface({input:child.stdout});child.stderr.resume();child.stdin.on('error',()=>{});
  let count=0,next=0;const pending=new Map<number,{resolve:(value:unknown)=>void;reject:()=>void}>();
  const fail=()=>{for(const p of pending.values())p.reject();pending.clear();};
  child.on('error',fail);child.on('exit',fail);
  lines.on('line',line=>{count+=line.length;if(count>1_000_000){fail();child.kill('SIGKILL');return;}try{const value=JSON.parse(line),p=pending.get(value.id);if(!p)return;pending.delete(value.id);if(value.error)p.reject();else p.resolve(value.result);}catch{fail();}});
  const rpc=(method:string,params:object)=>new Promise<unknown>((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject:()=>reject(new Error('model_catalog_unavailable'))});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  const timeout=setTimeout(()=>{fail();child.kill('SIGKILL');},10_000);
  try{
    await rpc('initialize',{clientInfo:{name:'lobby_docs',version:'0.1.0'},capabilities:{}});
    child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    return safeModels(await rpc('model/list',{limit:100}),config.allowedModels);
  }finally{clearTimeout(timeout);lines.close();child.kill('SIGKILL');}
}
