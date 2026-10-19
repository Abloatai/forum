import {authAuthority,identityLease,type Identity} from '../auth/index.js';
import {openAuthority} from '../server/index.js';
import type {Request as DocumentRequest} from '../document/index.js';

type Authority=ReturnType<typeof openAuthority>;
/** The only public data entry point. The issuer credential never leaves this service. */
export function hostedService(options:{verify?:(token:string)=>Promise<Identity>;authority?:(workspace:string)=>Authority}={}){
  const verify=identityLease(options.verify??authAuthority({url:'https://auth.abloatai.com'}));
  const workspaces=new Map<string,Authority>();
  let pending=0;
  const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
  return async(request:Request):Promise<Response>=>{
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    if(request.headers.has('origin'))return json({error:'native_client_required'},403);
    const authorization=request.headers.get('authorization');
    if(!authorization?.startsWith('Bearer '))return json({error:'auth_required'},401);
    if(pending>=64)return json({error:'service_busy'},503);
    pending++;
    try{
      const identity=await verify(authorization.slice(7));
      const expected=request.headers.get('x-forum-workspace');
      if(expected&&expected!==identity.organizationId)throw new Error('auth_required');
      let authority=workspaces.get(identity.organizationId);
      if(!authority){
        if(workspaces.size>=128)throw new Error('service_busy');
        authority=(options.authority??(workspace=>openAuthority(undefined,undefined,workspace)))(identity.organizationId);
        workspaces.set(identity.organizationId,authority);
      }
      if(Number(request.headers.get('content-length')??0)>1_048_576)return json({error:'request_too_large'},413);
      const text=await request.text();if(Buffer.byteLength(text)>1_048_576)return json({error:'request_too_large'},413);
      let input:DocumentRequest|{action:'session'};
      try{input=JSON.parse(text);}catch{return json({error:'invalid_request'},400);}
      if(input?.action==='session')return json({identity,workspace:await authority.workspace()});
      return json({result:await authority.request(input as DocumentRequest,identity.userId,identity.name)});
    }catch(error){
      const code=(error as Error).message;
      if(code==='auth_required')return json({error:code},401);
      if(['auth_unavailable','service_busy'].includes(code))return json({error:code},503);
      // Never expose upstream responses, credential values or server stacks.
      const safe=['document_not_found','invalid_request','invalid_title','invalid_version','invalid_steps','invalid_step','operation_id_reused','message_id_reused','invalid_message','document_too_large','stopped'];
      return json({error:safe.includes(code)?code:'request_failed'},400);
    }finally{pending--;}
  };
}
