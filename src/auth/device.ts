// Adapted from Coding packages/cli/src/auth/device/index.ts (RFC 8628).
import {secureOrigin,authAuthority,type AuthConfig,type Identity} from './authority.js';
export async function deviceLogin(config:AuthConfig & {site:string}, report:(code:string,url:string)=>void, signal:AbortSignal, fetcher:typeof fetch=fetch):Promise<{token:string;identity:Identity}> {
  const auth=secureOrigin(config.url),site=secureOrigin(config.site),clientId='ablo-cli';
  const request=(path:string,body?:object,token?:string)=>fetcher(new URL('/api/auth/'+path,auth),{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)]),headers:{origin:site,...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const response=await request('device/code',{client_id:clientId,scope:'openid profile email'});
  if(!response.ok)throw new Error('Could not start sign-in');
  const code=await response.json();
  if(typeof code.device_code!=='string'||code.device_code.length>4096||!code.device_code||typeof code.user_code!=='string'||!/^[A-Za-z0-9-]{4,32}$/.test(code.user_code)||!Number.isInteger(code.expires_in)||code.expires_in<1||code.expires_in>1800)throw new Error('Invalid sign-in response');
  const url=new URL('/cli',site);url.searchParams.set('user_code',code.user_code);report(code.user_code,url.href);
  const deadline=Date.now()+code.expires_in*1000;let interval=Math.min(60,Math.max(1,code.interval??5))*1000;
  let token:string|undefined;
  try {
    while(Date.now()<deadline){
      await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new Error('Sign-in cancelled'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},Math.min(interval,deadline-Date.now()));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
      const polled=await request('device/token',{grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:code.device_code,client_id:clientId});
      const body=await polled.json();
      if(polled.ok){if(body.token_type!=='Bearer'||typeof body.access_token!=='string'||!/^[A-Za-z0-9_-]{1,4096}$/.test(body.access_token))throw new Error('Invalid sign-in response');token=body.access_token;break;}
      if(body.error==='authorization_pending')continue;
      if(body.error==='slow_down'){interval+=5000;continue;}
      throw new Error(body.error==='access_denied'?'Sign-in denied':'Sign-in expired');
    }
    if(!token)throw new Error('Sign-in expired');
    const identity=await authAuthority(config,fetcher)(token);
    return {token,identity};
  } catch(error){if(token)await request('sign-out',{},token).catch(()=>{});throw error;}
}
