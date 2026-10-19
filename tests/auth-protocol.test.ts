import {test} from 'node:test';
import assert from 'node:assert/strict';
import {betterAuth} from 'better-auth';
import {memoryAdapter} from 'better-auth/adapters/memory';
import {emailOTP,bearer} from 'better-auth/plugins';
import {electron} from '@better-auth/electron';
import {nativeSignIn} from '../src/auth/index.js';

test('Forum uses the real Better Auth OTP and Electron S256 endpoints (in-memory issuer; simulated mail)',async()=>{
  let otp='';
  const auth=betterAuth({baseURL:'https://auth.abloatai.com',secret:'Forum protocol test secret only, no production credential',database:memoryAdapter({user:[],session:[],account:[],verification:[]}),trustedOrigins:['https://forum.abloatai.com','com.ablo.forum:/'],logger:{disabled:true},
    plugins:[electron(),bearer(),emailOTP({sendVerificationOTP:async value=>{otp=value.otp;}})]});
  const native=nativeSignIn('https://forum.abloatai.com',(input,init)=>auth.handler(new Request(input,init)));
  await native.sendEmailCode('sample@example.test');assert.match(otp,/^\d{6}$/);
  await assert.rejects(native.verifyEmailCode('sample@example.test','000000'===otp?'111111':'000000'));
  const sessionToken=await native.verifyEmailCode('sample@example.test',otp);assert.ok(sessionToken);
  // The transfer is authorized by the real issuer's session cookie, never a fabricated token.
  const session=await auth.api.getSession({headers:new Headers({authorization:`Bearer ${sessionToken}`})});
  assert.equal(session?.user.email,'sample@example.test');
  await native.sendEmailCode('sample@example.test');
  const signedIn=await auth.handler(new Request('https://auth.abloatai.com/api/auth/sign-in/email-otp',{method:'POST',headers:{origin:'https://forum.abloatai.com','content-type':'application/json'},body:JSON.stringify({email:'sample@example.test',otp})}));
  assert.equal(signedIn.status,200);
  const cookie=signedIn.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const start=new URL(native.beginGoogle()),query=start.search;
  const transfer=await auth.handler(new Request('https://auth.abloatai.com/api/auth/electron/transfer-user'+query,{method:'POST',headers:{cookie,origin:'https://forum.abloatai.com','content-type':'application/json'},body:'{}'}));
  assert.equal(transfer.status,200);const result=await transfer.json();assert.match(result.electron_authorization_code,/^[A-Za-z0-9]{32}$/);
  const callback='com.ablo.forum://auth/callback#token='+Buffer.from(JSON.stringify({state:start.searchParams.get('state'),identifier:result.electron_authorization_code})).toString('base64url');
  assert.ok(await native.completeGoogle(callback));await assert.rejects(native.completeGoogle(callback));
});
