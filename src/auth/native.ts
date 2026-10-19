import {randomBytes,createHash} from 'node:crypto';
import {secureOrigin} from './authority.js';

/** Coding's Ablo Electron protocol: S256 PKCE and a one-use authorization code. */
export function nativeSignIn(site:string,fetcher:typeof fetch=fetch,now:()=>number=Date.now){
  const origin=secureOrigin(site);
  let pending:{state:string;verifier:string;expiresAt:number}|undefined;
  async function post(path:string,body:object){
    const response=await fetcher('https://auth.abloatai.com/api/auth/'+path,{method:'POST',headers:{'content-type':'application/json','electron-origin':'com.ablo.forum:/'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Sign-in could not finish. Please try again.');
    return response.json();
  }
  const token=(value:unknown)=>{
    if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,4096}$/.test(value))throw new Error('Invalid sign-in response');return value;
  };
  const email=(value:unknown)=>{
    if(typeof value!=='string'||value.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))throw new Error('Enter a valid email address.');return value.trim().toLowerCase();
  };
  return {
    beginGoogle(){
      const state=randomBytes(16).toString('base64url'),verifier=randomBytes(32).toString('base64url');
      pending={state,verifier,expiresAt:now()+300000};
      const url=new URL('/signin/desktop/',origin);
      for(const[key,value]of Object.entries({client_id:'electron',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))url.searchParams.set(key,value);
      return url.href;
    },
    async completeGoogle(value:string){
      const url=new URL(value);
      if(!pending||pending.expiresAt<=now()||url.protocol!=='com.ablo.forum:'||url.hostname!=='auth'||url.pathname!=='/callback'||url.username||url.password||url.port||url.search||!url.hash.startsWith('#token=')||url.hash.length>4096)throw new Error('Invalid sign-in callback');
      const data=JSON.parse(Buffer.from(decodeURIComponent(url.hash.slice(7)),'base64url').toString('utf8'));
      if(data.state!==pending.state||typeof data.identifier!=='string'||!/^[A-Za-z0-9]{32}$/.test(data.identifier))throw new Error('Invalid sign-in callback');
      const {state,verifier}=pending;pending=undefined;
      return token((await post('electron/token',{token:data.identifier,state,code_verifier:verifier})).token);
    },
    async sendEmailCode(value:string){await post('email-otp/send-verification-otp',{email:email(value),type:'sign-in'});},
    async verifyEmailCode(value:string,code:string){
      if(typeof code!=='string'||!/^\d{6}$/.test(code))throw new Error('Enter the six-digit code.');
      return token((await post('sign-in/email-otp',{email:email(value),otp:code})).token);
    },
    cancel(){pending=undefined;},
  };
}
