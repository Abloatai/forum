// Adapted from Coding's src/desktop/sign-in.tsx; Ablo owns OAuth and code issuance.
import {createAuthClient} from 'better-auth/client';
import {electronProxyClient} from '@better-auth/electron/proxy';
const status=document.getElementById('desktop-status')!,open=document.getElementById('open-forum') as HTMLAnchorElement;
void (async()=>{
  const url=new URL(location.href),query=Object.fromEntries(['client_id','state','code_challenge','code_challenge_method'].map(key=>[key,url.searchParams.get(key)??'']));
  if(query.client_id!=='electron'||!/^[A-Za-z0-9_-]{22}$/.test(query.state!)||!/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge!)||query.code_challenge_method!=='S256')throw new Error('Open sign-in from Forum to try again.');
  const client=createAuthClient({baseURL:'https://auth.abloatai.com',plugins:[electronProxyClient({protocol:'com.ablo.forum'})]});
  const code=client.electron.getAuthorizationCode();
  if(code){
    try{
      const payload=JSON.parse(atob(decodeURIComponent(code).replace(/-/g,'+').replace(/_/g,'/')));
      if(payload.state===query.state&&/^[A-Za-z0-9]{32}$/.test(payload.identifier)){
        open.href=`com.ablo.forum://auth/callback#token=${code}`;open.hidden=false;status.textContent='Open Forum to finish signing in.';
        client.ensureElectronRedirect();return;
      }
    }catch{ /* An unrelated or expired transfer must not complete this sign-in. */ }
  }
  if(url.searchParams.has('error'))throw new Error('Sign-in did not finish. Return to Forum and try again.');
  const error=new URL(url);error.searchParams.set('error','oauth_failed');
  const result=await client.signIn.social({provider:'google',callbackURL:url.href,newUserCallbackURL:url.href,errorCallbackURL:error.href,fetchOptions:{query}});
  if(result.error)throw new Error('Could not continue with Google. Return to Forum and try again.');
})().catch(error=>{status.textContent=error.message;});
