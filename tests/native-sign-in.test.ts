import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {nativeSignIn} from '../src/auth/index.js';

test('native Google handoff binds one-use code to its state, S256 verifier and expiry',async()=>{
  let now=0,calls=0,challenge='';
  const signIn=nativeSignIn('https://forum.abloatai.com',async(input,init)=>{
    calls++;assert.equal(String(input),'https://auth.abloatai.com/api/auth/electron/token');
    assert.equal(new Headers(init?.headers).get('electron-origin'),'com.ablo.forum:/');
    const body=JSON.parse(String(init?.body));assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'),challenge);
    assert.equal(init?.redirect,'error');return Response.json({token:'native-session'});
  },()=>now);
  const callback=(state:string)=>'com.ablo.forum://auth/callback#token='+Buffer.from(JSON.stringify({state,identifier:'a'.repeat(32)})).toString('base64url');
  const url=new URL(signIn.beginGoogle());challenge=url.searchParams.get('code_challenge')!;
  assert.equal(url.pathname,'/signin/desktop/');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  const valid=callback(url.searchParams.get('state')!);
  for(const invalid of [callback('wrong'),valid.replace('com.ablo.forum:','com.ablo.other:'),valid.replace('/callback','/other'),valid.replace('://auth','://evil@auth')])await assert.rejects(signIn.completeGoogle(invalid));
  assert.equal(calls,0);assert.equal(await signIn.completeGoogle(valid),'native-session');assert.equal(calls,1);
  await assert.rejects(signIn.completeGoogle(valid));assert.equal(calls,1);
  const expired=new URL(signIn.beginGoogle());now=300000;await assert.rejects(signIn.completeGoogle(callback(expired.searchParams.get('state')!)));assert.equal(calls,1);
  const cancelled=new URL(signIn.beginGoogle());signIn.cancel();await assert.rejects(signIn.completeGoogle(callback(cancelled.searchParams.get('state')!)));
});
test('native email uses issuer OTP endpoints, validates input and never exposes a provider key',async()=>{
  const calls:{path:string;body:any}[]=[];
  const signIn=nativeSignIn('https://forum.abloatai.com',async(input,init)=>{calls.push({path:new URL(String(input)).pathname,body:JSON.parse(String(init?.body))});return Response.json({token:'email-session'});});
  await assert.rejects(signIn.sendEmailCode('a@@example.test'));await assert.rejects(signIn.verifyEmailCode('a@example.test','12345'));assert.equal(calls.length,0);
  await signIn.sendEmailCode(' Sample@Example.test ');assert.equal(await signIn.verifyEmailCode('sample@example.test','123456'),'email-session');
  assert.deepEqual(calls,[{path:'/api/auth/email-otp/send-verification-otp',body:{email:'sample@example.test',type:'sign-in'}},{path:'/api/auth/sign-in/email-otp',body:{email:'sample@example.test',otp:'123456'}}]);
});
