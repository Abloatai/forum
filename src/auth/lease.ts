// Coding's bounded process-local identity lease, applied to the complete proof.
import {createHash} from 'node:crypto';
import type {Identity} from './authority.js';
export const AUTH_LEASE_MS=5000;
export function identityLease(verify:(token:string)=>Promise<Identity>,now:()=>number=Date.now){
  const answers=new Map<string,Identity>(),pending=new Map<string,Promise<Identity>>();
  return async(token:string):Promise<Identity>=>{
    const key=createHash('sha256').update(token).digest('hex'),cached=answers.get(key);
    if(cached && cached.expiresAt!>now())return cached;
    answers.delete(key);
    let request=pending.get(key);
    if(!request){
      if(pending.size>=64)throw new Error('auth_unavailable');
      const expiresAt=now()+AUTH_LEASE_MS;
      request=verify(token).then(identity=>{
        if(now()>=expiresAt)throw new Error('auth_required');
        const proof={...identity,expiresAt};answers.set(key,proof);
        if(answers.size>512)answers.delete(answers.keys().next().value!);
        return proof;
      }).catch(()=>{answers.delete(key);throw new Error('auth_required');}).finally(()=>pending.delete(key));
      pending.set(key,request);
    }
    return request;
  };
}
