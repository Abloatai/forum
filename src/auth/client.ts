import {secureOrigin,type Identity} from './authority.js';
export function workspaceClient(origin:string,getToken:()=>string|undefined,expired:()=>void,fetcher:typeof fetch=fetch,getWorkspace:()=>string|undefined=()=>undefined){
  const endpoint=new URL('/api/rpc',secureOrigin(origin));
  return async(input:unknown)=>{
    const token=getToken();if(!token)throw new Error('auth_required');
    const response=await fetcher(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(getWorkspace()?{'x-forum-workspace':getWorkspace()!}:{})},body:JSON.stringify(input),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15_000)});
    if(response.status===401){expired();throw new Error('auth_required');}
    const body=await response.json();
    if(!response.ok)throw new Error(typeof body.error==='string'?body.error:'service_unavailable');
    if(input&&typeof input==='object'&&'action'in input&&input.action==='session'){
      const identity=body.identity;
      if(!identity||!['userId','organizationId','name','workspace'].every(key=>typeof identity[key]==='string'&&identity[key].length>0&&identity[key].length<=512)||identity.workspace!==identity.organizationId||typeof body.workspace!=='string'||!body.workspace)throw new Error('invalid_session');
    }
    return body as {identity:Identity;workspace:string;result:unknown};
  };
}
