import type {Draft,Snapshot} from '../document/index.js';
import type {Identity} from '../auth/authority.js';
import {browserDrafts} from './drafts.js';

let identity:Identity|undefined,scope='',drafts:ReturnType<typeof browserDrafts>|undefined;
let activeDraft:Draft|undefined;
let checkedAt=0,checked=false,checking:Promise<void>|undefined,popup:Window|null=null,message='';
async function rpc(input:unknown){
  const response=await fetch('/api/rpc',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json',...(identity?{'x-forum-workspace':identity.organizationId}:{})},body:JSON.stringify(input),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
  if(response.status===401){if(identity)location.reload();throw new Error('auth_required');}
  const body=await response.json();if(!response.ok)throw new Error(body.error??'service_unavailable');return body;
}
async function authState(){
  if(Date.now()-checkedAt>5000){
    checking??=(async()=>{
      try{
        const session=await rpc({action:'session'}),next=session.identity as Identity;
        if(!next||!next.userId||!next.organizationId||next.workspace!==next.organizationId||typeof session.workspace!=='string')throw new Error('Invalid session');
        const nextScope=[session.workspace,next.organizationId,next.userId].map(encodeURIComponent).join(':');
        if(checked&&(!identity||scope!==nextScope)){popup?.close();location.reload();return;}
        identity=next;scope=nextScope;drafts??=browserDrafts(scope);message='';
      }catch(error){if((error as Error).message!=='auth_required')message='Could not connect. Retrying…';}
      finally{checked=true;checkedAt=Date.now();checking=undefined;}
    })();
    await checking;
  }
  return {local:false,signedIn:!!identity,name:identity?.name??'',pending:false,message,code:''};
}
window.lobbyDocs={
  browser:true,authState,
  async signIn(){
    if(popup&&!popup.closed){popup.focus();return;}
    popup=window.open('about:blank','forum-sign-in','popup,width=540,height=740');
    checked=false;checkedAt=0;
    if((await authState()).signedIn){popup?.close();location.reload();return;}
    // Reuse Coding's ordinary Google/email sign-in and shared HttpOnly cookie.
    // No device approval or exported bearer token is required.
    if(popup)popup.location.href='https://www.abloatai.com/signin?next=%2Fapp';
    message=popup?'Finish signing in in the other window.':'Allow the sign-in window, then try again.';
  },
  async signOut(){
    try{
      const response=await fetch('https://auth.abloatai.com/api/auth/sign-out',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('Sign-out failed');location.reload();
    }catch{const error=document.getElementById('error')!;error.hidden=false;error.textContent='Could not sign out. Please try again.';}
  },
  async list(){return identity?(await rpc({action:'list'})).result:[];},
  async create(title:string){return (await rpc({action:'create',id:crypto.randomUUID(),title})).result;},
  async open(id:string){
    const base=(await rpc({action:'open',id})).result as Snapshot;
    if(!drafts)throw new Error('auth_required');activeDraft=await drafts.open(id,base);return activeDraft;
  },
  async request(input){
    if(!activeDraft||input.id!==activeDraft.id)throw new Error('Invalid document request');
    return (await rpc({...input,clientID:activeDraft.clientID})).result;
  },
  saveDraft(draft:Draft){return drafts?.save(draft)??{ok:false,error:'Sign in to save your draft.'};},
  async offline(value:boolean){return value;},
  async newWindow(){window.open('/app/','_blank','noopener');},
};
void import('../renderer/index.js');
