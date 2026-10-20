import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openAccount,codexCommand} from './account.js';
import {encryptedStore,type Store,type Saved} from './storage.js';
import {runAgent,type PersonalAgentConfig} from '../agent/cli.js';
export function personalCodex(store:Store,open=openAccount,waitUntil?:(work:Promise<void>)=>void,execute=runAgent){
 const publicView=(saved:Saved)=>({connected:!!saved.value.auth,...(saved.value.view?{account:saved.value.view}:{}),...(saved.value.login&&saved.value.login.expiresAt>Date.now()?{login:saved.value.login}:{}),...(saved.value.error?{error:saved.value.error}:{})});
 async function connected(user:string,generation?:string){const saved=await store.read(user);if(!saved.value.auth||(generation&&saved.value.generation!==generation))throw new Error('codex_connection_required');return saved;}
 return {
  async request(user:string,action:string){
   const saved=await store.read(user);
   if(action==='codex-status')return publicView(saved);
   if(action==='codex-disconnect'){await store.write(user,{generation:randomUUID()},saved);return {connected:false};}
   if(action!=='codex-connect')throw new Error('invalid_request');
   if(saved.value.auth)return publicView(saved);
   if((saved.value.leaseUntil??0)>Date.now())return publicView(saved);
   const generation=randomUUID(),expiresAt=Date.now()+240000;
   let leased=await store.write(user,{generation,leaseUntil:expiresAt},saved),account:Awaited<ReturnType<typeof open>>;
   try{account=await open();}catch{await store.write(user,{generation,error:'Codex sign-in could not start. Try again.'},leased);throw new Error('codex_unavailable');}
   try{
    const login=await account.request<{verificationUrl:string;userCode:string}>('account/login/start',{type:'chatgptDeviceCode'});
    if(login.verificationUrl!=='https://auth.openai.com/codex/device'||!/^[A-Z0-9-]{4,32}$/i.test(login.userCode))throw new Error('codex_unavailable');
    leased=await store.write(user,{generation,leaseUntil:expiresAt,login:{...login,expiresAt}},leased);
    const finish=async()=>{let timer:NodeJS.Timeout|undefined;try{
     const success=await Promise.race([account.completed,new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(0,expiresAt-Date.now()));})]);if(!success)throw new Error('codex_unavailable');
     const result=await account.read(),current=await store.read(user);if(current.value.generation!==generation)return;
     await store.write(user,{generation,...result,updatedAt:Date.now()},current);
    }catch{const current=await store.read(user);if(current.value.generation===generation)await store.write(user,{generation,error:'Sign-in did not complete. Enable device-code login in ChatGPT security settings and try again.'},current);}finally{clearTimeout(timer);await account.close();}};
    // Always drain failures; server lifecycle owns the bounded login wait.
    const work=finish().catch(()=>{});waitUntil?.(work);return publicView(leased);
   }catch{await account.close();const current=await store.read(user);if(current.value.generation===generation)await store.write(user,{generation,error:'Could not start Codex sign-in. Try again.'},current);throw new Error('codex_unavailable');}
  },
  async agent(user:string):Promise<PersonalAgentConfig|undefined>{
   const saved=await store.read(user);if(!saved.value.auth)return;
   const generation=saved.value.generation;
   return {personal:true,models:saved.value.view?.models??[],waitUntil,async run(model,prompt,tool,signal,authorize){
    let current=await connected(user,generation);
    const check=async()=>{signal.throwIfAborted();await authorize();await connected(user,generation);};
    await check();
    // A conditional per-user lease serializes refresh across server instances.
    if((current.value.leaseUntil??0)>Date.now())throw new Error('codex_busy');
    let auth=current.value.auth!;
    if((current.value.updatedAt??0)<Date.now()-60000){
     const lease=await store.write(user,{...current.value,leaseUntil:Date.now()+90000},current);
     let account:Awaited<ReturnType<typeof open>>|undefined;
     try{account=await open(auth);const refreshed=await account.read(true);await check();current=await store.write(user,{generation,...refreshed,updatedAt:Date.now()},lease);auth=current.value.auth!;}
     catch{const latest=await store.read(user);if(latest.value.generation===generation)await store.write(user,{...latest.value,leaseUntil:0,error:'Reconnect Codex to continue.'},latest).catch(()=>{});throw new Error('codex_connection_required');}
     finally{await account?.close();}
    }
    const home=await mkdtemp(join(tmpdir(),'forum-personal-codex-'));
    try{
     await writeFile(join(home,'auth.json'),auth,{mode:0o600});
     await writeFile(join(home,'config.toml'),'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n',{mode:0o600});
     await check();const answer=await execute({command:codexCommand(),home,model,models:saved.value.view?.models},prompt,tool,signal,check);await check();
     const refreshed=await readFile(join(home,'auth.json'),'utf8');if(refreshed!==auth)await store.write(user,{...current.value,auth:refreshed,updatedAt:Date.now()},current);
     return answer;
    }finally{await rm(home,{recursive:true,force:true});}
   }};
  },
 };
}
export function configuredCodex(waitUntil?:(work:Promise<void>)=>void){const key=process.env.FORUM_CODEX_ENCRYPTION_KEY;return key?personalCodex(encryptedStore(key),undefined,waitUntil):undefined;}
