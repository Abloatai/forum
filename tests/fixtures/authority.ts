// In-memory Ablo contract double for offline checks. Live SDK checks use the real service.
import {openAuthority as open,startServer as start} from '../../src/server/index.js';
import type {actorClients,Client} from '../../src/ablo/index.js';
import type {AgentConfig} from '../../src/agent/cli.js';
type Row={id:string;[key:string]:any};
type Operation={action:string;model:string;id:string;data:Record<string,unknown>};
const stores=new Map<string,Map<string,{row:Row;revision:number}>>();
export function clients(path:string):ReturnType<typeof actorClients>{
 const rows=stores.get(path)??new Map();stores.set(path,rows);
 return {
  async workspace(){return `synthetic:${path}`;},async close(){},async release(){},
  get(){
   const evidence=new WeakMap<object,{key:string;revision:number}>();
   async function commit({operations,reads=[]}:{operations:Operation[];reads?:object[]}){
    for(const read of reads){const proof=evidence.get(read);if(!proof)throw new Error('read_evidence_client_mismatch');if(rows.get(proof.key)?.revision!==proof.revision)throw Object.assign(new Error('stale_context'),{code:'stale_context'});}
    const next=new Map(rows);
    for(const op of operations){const key=`${op.model}:${op.id}`,old=next.get(key);if(op.action==='create'&&old)throw new Error('row_exists');if(op.action==='update'&&!old)throw new Error('row_missing');next.set(key,{row:{...old?.row,...structuredClone(op.data),id:op.id},revision:(old?.revision??0)+1});}
    rows.clear();for(const [key,value]of next)rows.set(key,value);
   }
   const client:Record<string,unknown>={commits:{create:commit},async dispose(){}};
   for(const model of ['forumCodexConnections','forumDocuments','forumSteps','forumReceipts','forumMessages','forumRuns'])client[model]={
    async read({id}:{id:string}){const key=`${model}:${id}`,stored=rows.get(key);if(!stored)return null;const row=structuredClone(stored.row);evidence.set(row,{key,revision:stored.revision});return row;},
    async list({where={},orderBy={},limit=1000}:{where?:Record<string,unknown>|unknown[][];orderBy?:Record<string,string>;limit?:number}={}){
     const filters=Array.isArray(where)?where:Object.entries(where).map(([key,value])=>[key,'=',value]);
     const result=[...rows.entries()].filter(([key])=>key.startsWith(`${model}:`)).map(([,value])=>structuredClone(value.row)).filter(row=>filters.every(([key,operator,value])=>operator==='>'?row[String(key)]>(value as number):operator==='<='?row[String(key)]<=(value as number):row[String(key)]===value));
     result.sort((a,b)=>{for(const [key,direction]of Object.entries(orderBy)){if(a[key]!==b[key])return (a[key]<b[key]?-1:1)*(direction==='desc'?-1:1);}return 0;});return result.slice(0,limit);
    },
    async update({id,data}:{id:string;data:Record<string,unknown>}){await commit({operations:[{action:'update',model,id,data}]});},
   };
   return client as unknown as Client;
  },
 };
}
export function openAuthority(path:string,agent?:Parameters<typeof open>[0],workspace='local'){return open(agent,clients(path),workspace);}
export function startServer(options:Parameters<typeof start>[0]&{database:string}){const {database,...rest}=options;return start({...rest,clients:clients(database)});}
