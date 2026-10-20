import {authAuthority,identityLease,browserSessionCookie,type Identity} from '../auth/index.js';
import {openAuthority} from '../server/index.js';
import type {Request as DocumentRequest} from '../document/index.js';
import {configuredCodex,type personalCodex} from '../codex/index.js';

import {membersService} from '../members/index.js';

type Authority=ReturnType<typeof openAuthority>;
/** The only public data entry point. The issuer credential never leaves this service. */
export function hostedService(options:{verify?:(token:string)=>Promise<Identity>;verifyBrowser?:(cookie:string)=>Promise<Identity>;browserOrigin?:string;authority?:(workspace:string)=>Authority;waitUntil?:(work:Promise<void>)=>void;codex?:ReturnType<typeof personalCodex>;teamFetch?:typeof fetch}={}){
  const prove=options.verify??authAuthority({url:'https://auth.abloatai.com'});
  const proveBrowser=options.verifyBrowser??authAuthority({url:'https://auth.abloatai.com'},fetch,'cookie');
  const verify=identityLease(prove);
  const verifyBrowser=identityLease(proveBrowser);
  const verifySession=options.verify??authAuthority({url:'https://auth.abloatai.com'},fetch,'bearer',true);
  const verifyBrowserSession=options.verifyBrowser??authAuthority({url:'https://auth.abloatai.com'},fetch,'cookie',true);
  const team=membersService(options.teamFetch);
  const browserOrigin=options.browserOrigin??'https://forum.abloatai.com';
  const codex=options.codex??configuredCodex(options.waitUntil);
  const workspaces=new Map<string,Authority>();
  let pending=0;
  const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
  return async(request:Request):Promise<Response>=>{
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    const origin=request.headers.get('origin');
    if(origin&&origin!==browserOrigin)return json({error:'invalid_origin'},403);
    const authorization=request.headers.get('authorization');
    // Cookie authority is same-origin only; native bearer clients retain their boundary.
    if(authorization&&origin)return json({error:'native_client_required'},403);
    const cookie=browserSessionCookie(request.headers),browser=!authorization&&origin===browserOrigin;
    if(!browser&&!authorization?.startsWith('Bearer '))return json({error:'auth_required'},401);
    if(pending>=64)return json({error:'service_busy'},503);
    pending++;
    try{
      if(Number(request.headers.get('content-length')??0)>1_048_576)return json({error:'request_too_large'},413);
      const text=await request.text();if(Buffer.byteLength(text)>1_048_576)return json({error:'request_too_large'},413);
      let input:DocumentRequest|{action:'session'};
      try{input=JSON.parse(text);}catch{return json({error:'invalid_request'},400);}
      if(browser&&!cookie)throw new Error('auth_required');
      const setup=input?.action==='session'||input?.action?.startsWith('team-');
      let identity=browser?await (setup?verifyBrowserSession:verifyBrowser)(cookie):await (setup?verifySession:verify)(authorization!.slice(7));
      if(input?.action?.startsWith('team-')){const result=await team(input as DocumentRequest,identity,browser?{cookie}:{authorization:authorization!},browserOrigin);const response=json({result:result.value});if(browser)for(const value of result.cookies)response.headers.append('set-cookie',value);return response;}
      if(input?.action==='session'&&!identity.organizationId)return json({identity,workspace:'',needsWorkspace:true});
      if(!identity.organizationId)throw new Error('auth_required');
      const expected=request.headers.get('x-forum-workspace');
      if(expected&&expected!==identity.organizationId)identity=await(browser?proveBrowser(cookie):prove(authorization!.slice(7)));
      if(expected&&expected!==identity.organizationId)throw new Error('auth_required');
      if(['codex-status','codex-connect','codex-disconnect'].includes(input?.action)){
        if(!codex)return json({error:'codex_unavailable'},503);
        return json({result:await codex.request(identity.userId,input.action)});
      }
      let authority=workspaces.get(identity.organizationId);
      if(!authority){
        if(workspaces.size>=128)throw new Error('service_busy');
        authority=(options.authority??(workspace=>openAuthority(codex?actor=>codex.agent(actor):undefined,undefined,workspace)))(identity.organizationId);
        workspaces.set(identity.organizationId,authority);
      }
      if(input?.action==='session')return json({identity,workspace:await authority.workspace()});
      const authorize=async()=>{let current=browser?await verifyBrowser(cookie):await verify(authorization!.slice(7));if(current.organizationId!==identity.organizationId)current=await(browser?proveBrowser(cookie):prove(authorization!.slice(7)));if(current.userId!==identity.userId||current.organizationId!==identity.organizationId)throw new Error('auth_required');};
      return json({result:await authority.request(input as DocumentRequest,identity.userId,identity.name,authorize)});
    }catch(error){
      const code=(error as Error).message;
      if(code==='auth_required')return json({error:code},401);
      if(['auth_unavailable','service_busy'].includes(code))return json({error:code},503);
      // Never expose upstream responses, credential values or server stacks.
      const safe=['document_not_found','invalid_request','invalid_title','invalid_version','invalid_steps','invalid_step','operation_id_reused','message_id_reused','invalid_message','document_too_large','stopped','agent_unavailable','model_not_allowed','model_catalog_unavailable','codex_connection_required','codex_unavailable','codex_busy','codex_changed','team_forbidden','team_unavailable','invalid_email','invitation_unavailable','invalid_workspace_name'];
      return json({error:safe.includes(code)?code:'request_failed'},400);
    }finally{pending--;}
  };
}
