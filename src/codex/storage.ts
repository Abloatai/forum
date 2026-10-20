import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import Ablo from '@abloatai/ablo';
import {abloSchema,commit,type Client} from '../ablo/index.js';
import type {Model} from '../agent/models.js';
export type Connection={generation:string;auth?:string;view?:{email:string;plan:string;models:Model[]};login?:{verificationUrl:string;userCode:string;expiresAt:number};leaseUntil?:number;updatedAt?:number;error?:string};
export type Saved={value:Connection;proof?:NonNullable<Awaited<ReturnType<Client['forumCodexConnections']['read']>>>};
export type Store={read(user:string):Promise<Saved>;write(user:string,value:Connection,previous:Saved):Promise<Saved>};
export function encryptedStore(key:string,apiKey=process.env.ABLO_API_KEY,client=Ablo({schema:abloSchema,apiKey,transport:'http'})):Store{
 if(!/^[a-f0-9]{64}$/i.test(key))throw new Error('invalid_codex_encryption_key');
 const secret=Buffer.from(key,'hex');
 const id=(user:string)=>createHash('sha256').update('forum-codex:'+user).digest('hex');
 function seal(user:string,value:Connection){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(Buffer.from(id(user)));const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');}
 function open(user:string,payload:string):Connection{const bytes=Buffer.from(payload,'base64'),cipher=createDecipheriv('aes-256-gcm',secret,bytes.subarray(0,12));cipher.setAAD(Buffer.from(id(user)));cipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));}
 return {async read(user){const row=await client.forumCodexConnections.read({id:id(user)});return {value:row?open(user,row.payload):{generation:''},...(row?{proof:row}:{})};},async write(user,value,previous){
  const payload=seal(user,value);
  await commit(client,{operations:[{action:previous.proof?'update':'create',model:'forumCodexConnections',id:id(user),data:{payload}}],reads:previous.proof?[previous.proof]:[],idempotencyKey:randomBytes(16).toString('hex'),wait:'confirmed'});
  const row=await client.forumCodexConnections.read({id:id(user)});if(!row||row.payload!==payload)throw new Error('codex_changed');return {value:open(user,row.payload),proof:row};
 }};
}
