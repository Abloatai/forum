import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {identityLease} from '../src/auth/lease.js';
import {sessionStorage} from '../src/auth/storage.js';
import {workspaceClient} from '../src/auth/client.js';
import {hostedService} from '../src/hosted/index.js';
import {openAuthority} from './fixtures/authority.js';
const identity={userId:'sample',name:'Sample',organizationId:'sample-team',workspace:'sample-team'};

test('identity verification deduplicates callers, bounds pending requests and discards late proofs',async()=>{
 let release!:()=>void,calls=0,now=0;const gate=new Promise<void>(resolve=>release=resolve);
 const verify=identityLease(async()=>{calls++;await gate;return identity;},()=>now);
 const first=verify('same'),duplicate=verify('same');assert.equal(calls,1);
 const rest=Array.from({length:63},(_,i)=>verify('other-'+i));
 await assert.rejects(verify('overflow'),/auth_unavailable/);assert.equal(calls,64);
 release();assert.deepEqual(await first,await duplicate);await Promise.all(rest);
 let complete!:()=>void;const delayed=identityLease(async()=>{await new Promise<void>(done=>complete=done);return identity;},()=>now);
 const late=delayed('late');now=5000;complete();await assert.rejects(late,/auth_required/);
});

test('native storage refuses insecure vaults and corrupt sessions without overwriting a valid session',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'forum-vault-'));
 const vault={isEncryptionAvailable:()=>true,encryptString:(value:string)=>Buffer.from(value.split('').reverse().join('')),decryptString:(bytes:Buffer)=>bytes.toString().split('').reverse().join('')};
 try{
  const store=sessionStorage(directory,'https://forum.test',vault),value={token:'synthetic-session',identity};
  assert.equal(store.save(value),true);const original=await readFile(join(directory,'auth-session.bin'));
  const broken=sessionStorage(directory,'https://forum.test',{...vault,encryptString:()=>{throw Error('vault unavailable');}});
  assert.equal(broken.save({...value,token:'replacement'}),false);assert.deepEqual(await readFile(join(directory,'auth-session.bin')),original);
  for(const insecure of [{...vault,isEncryptionAvailable:()=>false},{...vault,getSelectedStorageBackend:()=>'basic_text'}]){
   const disabled=sessionStorage(directory,'https://forum.test',insecure);assert.equal(disabled.save(value),false);assert.equal(disabled.load(),undefined);
  }
  await writeFile(join(directory,'auth-session.bin'),'corrupt');assert.equal(store.load(),undefined);
  await writeFile(join(directory,'auth-session.bin'),vault.encryptString(JSON.stringify({binding:'https://forum.test',token:123,identity})));assert.equal(store.load(),undefined);
  store.clear();assert.equal(store.load(),undefined);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('native RPC validates session shape and retains authorization on transient server errors',async()=>{
 let calls=0,expired=0;
 const noToken=workspaceClient('https://forum.test',()=>undefined,()=>expired++,async()=>{calls++;return Response.json({});});
 await assert.rejects(noToken({action:'session'}),/auth_required/);assert.equal(calls,0);
 let payload:any={identity,workspace:'service-workspace'},status=200;
 const rpc=workspaceClient('https://forum.test',()=>'synthetic-token',()=>expired++,async()=>Response.json(payload,{status}));
 assert.deepEqual((await rpc({action:'session'})).identity,identity);
 for(const invalid of [null,{...identity,userId:''},{...identity,name:'x'.repeat(513)},{...identity,workspace:'other-team'}]){
  payload={identity:invalid,workspace:'service-workspace'};await assert.rejects(rpc({action:'session'}),/invalid_session/);
 }
 payload={};status=503;await assert.rejects(rpc({action:'list'}),/service_unavailable/);assert.equal(expired,0);
 payload={error:'service_busy'};await assert.rejects(rpc({action:'list'}),/service_busy/);assert.equal(expired,0);
});

test('hosted API bounds admission and malformed bodies, then recovers after verification completes',async()=>{
 const authority=openAuthority(randomUUID()),token='synthetic-token';let release!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve);
 const service=hostedService({verify:async()=>{await gate;return identity;},authority:()=>authority});
 const request=(body:string,headers:Record<string,string>={})=>service(new Request('https://forum.test/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,...headers},body}));
 try{
  assert.equal((await service(new Request('https://forum.test/api/rpc'))).status,405);
  assert.equal((await request('{')).status,400);
  assert.equal((await request('{}',{'content-length':'1048577'})).status,413);
  assert.equal((await request(' '.repeat(1048577))).status,413);
  const pending=Array.from({length:64},()=>request('{"action":"session"}'));
  assert.equal((await request('{"action":"session"}')).status,503);
  release();const responses=await Promise.all(pending);assert.ok(responses.every(response=>response.status===200));
  assert.equal((await request('{"action":"session"}')).status,200);
 }finally{release();await authority.close();}
});
