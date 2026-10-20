import Ablo,{type AbloHttpClient} from '@abloatai/ablo';
import {setTimeout as delay} from 'node:timers/promises';
import Sessions from '@abloatai/ablo/sessions';
import {schema as abloSchema} from './schema.js';
export {schema as abloSchema} from './schema.js';
export type Client=AbloHttpClient<typeof abloSchema.models>;

// Contention is safe to retry unchanged. Stale captured reads must reach the caller.
export async function commit(client:Client,input:Parameters<Client['commits']['create']>[0]){
  for(let attempt=0;;attempt++){
    try{return await client.commits.create(input);}
    catch(error){
      if(!error||typeof error!=='object'||!('code' in error)||error.code!=='decision_contended'||attempt>=5)throw error;
      await delay(25*2**attempt+Math.floor(Math.random()*25));
    }
  }
}

// Project credentials and actor sessions stay in the native authority process.
export function actorClients(apiKey=process.env.ABLO_API_KEY){
  if(!apiKey?.startsWith('sk_'))throw new Error('Forum requires an Ablo development branch key. Run ablo dev for your own project.');
  const issuer=Sessions({schema:abloSchema,apiKey});
  const clients=new Map<string,Client>();
  return {
    async workspace(){
      const session=await issuer.create({user:{id:'forum-local-bootstrap'},can:{forumDocuments:['read']},ttlSeconds:60});
      if(!session.scope.projectId||!session.scope.branchId)throw new Error('Forum needs an isolated Ablo development branch');
      return `${session.organizationId}:${session.scope.projectId}:${session.scope.branchId}`;
    },
    get(id:string,agent=false){
      let client=clients.get(id);
      if(!client){
        if(clients.size>=256)throw new Error('workspace_busy');
        const can={forumDocuments:['read','update',...(!agent?['create' as const]:[])],forumSteps:['read','create'],forumReceipts:['read','create'],forumMessages:['read','create'],forumRuns:['read','create','update']} as const;
        client=Ablo({schema:abloSchema,transport:'http',session:()=>issuer.create({...agent?{agent:{id}}:{user:{id}},can,ttlSeconds:600})});
        clients.set(id,client);
      }
      return client;
    },
    async release(id:string){const client=clients.get(id);clients.delete(id);await client?.dispose();},
    async close(){await Promise.all([...clients.values()].map(client=>client.dispose()));clients.clear();},
  };
}
