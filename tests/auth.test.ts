import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {authAuthority,secureOrigin,browserSessionCookie,type Identity} from '../src/auth/index.js';
import {identityLease} from '../src/auth/lease.js';
import {sessionStorage} from '../src/auth/storage.js';
import {workspaceClient} from '../src/auth/client.js';
import {hostedService} from '../src/hosted/index.js';
import {openAuthority} from './fixtures/authority.js';

const alice:Identity={userId:'alice',organizationId:'team-a',workspace:'team-a',name:'Alice'};
test('authentication requires a current issuer session and matching organization membership',async()=>{
  let member:any={userId:'alice',organizationId:'team-a',role:'member'},session:any={user:{id:'alice',name:'Alice'},session:{activeOrganizationId:'team-a'}};
  const verify=authAuthority({url:'https://auth.example.test'},async(input,init)=>{
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer session-token');assert.equal(init?.redirect,'error');
    return Response.json(String(input).includes('get-session')?session:member);
  });
  assert.deepEqual(await verify('session-token'),alice);
  for(const invalid of [{...member,userId:'other'},{...member,organizationId:'other'},{...member,role:''}]){member=invalid;await assert.rejects(verify('session-token'),/auth_required/);}
  session.user.banned=true;await assert.rejects(verify('session-token'),/auth_required/);
  for(const url of ['http://remote.test','https://auth.test/path','https://user:pass@auth.test'])assert.throws(()=>secureOrigin(url));
});
test('membership leases expire and fail closed after revocation',async()=>{
  let now=0,revoked=false,calls=0;
  const verify=identityLease(async()=>{calls++;if(revoked)throw new Error('auth_required');return alice;},()=>now);
  await verify('token');revoked=true;now=4999;await verify('token');assert.equal(calls,1);
  now=5000;await assert.rejects(verify('token'),/auth_required/);assert.equal(calls,2);
});
test('hosted RPC separates workspaces and rejects unauthenticated, mismatched and cross-workspace requests',async()=>{
  const store=randomUUID(),service=hostedService({verify:async token=>{if(!['alice','bob'].includes(token))throw new Error('auth_required');return token==='alice'?alice:{...alice,userId:'bob',organizationId:'team-b',workspace:'team-b',name:'Bob'};},authority:workspace=>openAuthority(store,undefined,workspace)});
  async function call(token:string,input:unknown,headers:Record<string,string>={}){const response=await service(new Request('https://forum.test/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,...headers},body:JSON.stringify(input)}));return {status:response.status,body:await response.json()};}
  assert.equal((await call('expired',{action:'session'})).status,401);
  assert.equal((await call('alice',{action:'session'},{origin:'https://evil.test'})).status,403);
  assert.equal((await call('alice',{action:'session'},{'x-forum-workspace':'team-b'})).status,401);
  const id=randomUUID();assert.equal((await call('alice',{action:'create',id,title:'Alice document'})).status,200);
  assert.deepEqual((await call('bob',{action:'list'})).body.result,[]);
  for(const action of ['open','create','chat-state','chat-stop'])assert.equal((await call('bob',{action,id,title:'overwrite',clientID:'bob'})).body.error,'document_not_found');
  const own=await call('alice',{action:'open',id});assert.equal(own.body.result.title,'Alice document');
  await call('alice',{action:'chat-send',id,clientID:'draft',messageID:randomUUID(),text:'Hello',agent:false});
  const chat=await call('alice',{action:'chat-state',id,clientID:'draft'});assert.equal(chat.body.result.messages[0].author,'Alice');
});
test('native sessions stay in encrypted storage and workspace changes force reauthentication',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'forum-auth-'));
  const vault={isEncryptionAvailable:()=>true,encryptString:(value:string)=>Buffer.from(Buffer.from(value).map(byte=>byte^0xff)),decryptString:(value:Buffer)=>Buffer.from(value.map(byte=>byte^0xff)).toString()};
  try{
    const store=sessionStorage(directory,'https://forum.test',vault);assert.equal(store.save({token:'sensitive-session',identity:alice}),true);
    assert.equal((await readFile(join(directory,'auth-session.bin'))).includes('sensitive-session'),false);
    assert.equal(store.load()?.identity.userId,'alice');assert.equal(sessionStorage(directory,'https://other.test',vault).load(),undefined);
    let expired=false;const client=workspaceClient('https://forum.test',()=>store.load()?.token,()=>{expired=true;store.clear();},async(_url,init)=>{
      assert.equal(new Headers(init?.headers).get('x-forum-workspace'),'team-a');return Response.json({error:'auth_required'},{status:401});
    },()=>alice.organizationId);
    await assert.rejects(client({action:'list'}),/auth_required/);assert.equal(expired,true);assert.equal(store.load(),undefined);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('browser RPC reuses only the Ablo cookie with exact-origin CSRF and workspace isolation',async()=>{
  const store=randomUUID();
  const verifyBrowser=authAuthority({url:'https://auth.example.test'},async(input,init)=>{
    assert.equal(new Headers(init?.headers).get('cookie'),'__Secure-better-auth.session_token=signed-session');
    assert.equal(new Headers(init?.headers).has('authorization'),false);
    return Response.json(String(input).includes('get-session')?{user:{id:'alice',name:'Alice'},session:{activeOrganizationId:'team-a'}}:{userId:'alice',organizationId:'team-a',role:'member'});
  },'cookie');
  const service=hostedService({verifyBrowser,authority:workspace=>openAuthority(store,undefined,workspace)});
  const cookie='unrelated=secret; __Secure-better-auth.session_token=signed-session; better-auth-staging.session_token=staging';
  assert.equal(browserSessionCookie(new Headers({cookie})),'__Secure-better-auth.session_token=signed-session');
  const call=(input:unknown,headers:Record<string,string>={})=>service(new Request('https://forum.abloatai.com/api/rpc',{method:'POST',headers:{origin:'https://forum.abloatai.com',cookie,...headers},body:JSON.stringify(input)}));
  assert.equal((await call({action:'session'})).status,200);
  for(const origin of ['https://evil.test','https://forum.abloatai.com.evil.test','https://lobby.abloatai.com','null'])assert.equal((await call({action:'create',id:randomUUID(),title:'CSRF'},{origin})).status,403);
  assert.equal((await call({action:'session'},{origin:''})).status,401);
  assert.equal((await call({action:'session'},{cookie:''})).status,401);
  assert.equal((await call({action:'session'},{'x-forum-workspace':'team-b'})).status,401);
  const signedOut=await call({action:'browser-sign-out'});assert.match(signedOut.headers.get('set-cookie')!,/__Host-forum-signed-out=1;.*HttpOnly/);
  assert.equal((await call({action:'session'},{cookie:cookie+'; __Host-forum-signed-out=1'})).status,401);
  const signedIn=await call({action:'browser-sign-in'});assert.match(signedIn.headers.get('set-cookie')!,/Max-Age=0/);
});
test('browser identity without an active team requires an actual organization membership',async()=>{
  let members:any[]=[{userId:'alice',organizationId:'team-a',role:'member'}];
  const verify=authAuthority({url:'https://auth.example.test'},async(input)=>{
    const url=String(input);return Response.json(url.includes('get-session')?{user:{id:'alice',name:'Alice'},session:{}}:url.endsWith('organization/list')?[{id:'team-a'}]:{members});
  },'cookie');
  assert.deepEqual(await verify('better-auth.session_token=sample'),alice);
  members=[{userId:'other',organizationId:'team-a',role:'member'}];await assert.rejects(verify('better-auth.session_token=sample'),/auth_required/);
});
