import type {Identity} from '../auth/index.js';
import type {Request as Input} from '../document/index.js';
const canInvite=(role:string)=>role.split(',').some(value=>['owner','admin'].includes(value.trim()));
/** Auth owns all grants; Forum accepts neither a browser role nor a membership assertion. */
export function membersService(fetcher:typeof fetch=fetch){
 return async(input:Input,identity:Identity,credential:{cookie:string}|{authorization:string},origin:string)=>{
  let cookies:string[]=[];
  async function auth(path:string,body?:object){
   const response=await fetcher(new URL('/api/auth/organization/'+path,'https://auth.abloatai.com'),{method:body?'POST':'GET',headers:{...credential,origin,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error(response.status===401?'auth_required':response.status===403?'team_forbidden':'team_unavailable');
   cookies=response.headers.getSetCookie();return response.json();
  }
  const accounts=await auth('list') as {id:string;name:string}[];
  if(!Array.isArray(accounts))throw new Error('team_unavailable');
  if(input.action==='team-switch'){
   if(typeof input.organizationId!=='string'||!accounts.some(row=>row.id===input.organizationId))throw new Error('team_forbidden');
   await auth('set-active',{organizationId:input.organizationId});return {value:{ok:true},cookies};
  }
  if(input.action==='team-create'){
   if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>80)throw new Error('invalid_workspace_name');
   const created=await auth('create',{name:input.name.trim(),slug:'forum-'+crypto.randomUUID()});if(typeof created.id!=='string')throw new Error('team_unavailable');
   await auth('set-active',{organizationId:created.id});return {value:{ok:true},cookies};
  }
  const incoming=await auth('list-user-invitations') as any[];
  const pending=(row:any)=>row.status==='pending'&&Date.parse(row.expiresAt)>Date.now();
  if(input.action==='team-accept'){
   if(typeof input.invitationId!=='string'||!incoming.some(row=>row.id===input.invitationId&&pending(row)))throw new Error('invitation_unavailable');
   // Auth verifies the recipient and expiry again at acceptance.
   const invitation=incoming.find(row=>row.id===input.invitationId)!;await auth('accept-invitation',{invitationId:invitation.id});await auth('set-active',{organizationId:invitation.organizationId});return {value:{ok:true},cookies};
  }
  const organization=identity.organizationId?await auth('get-full-organization?organizationId='+encodeURIComponent(identity.organizationId)):null;
  const member=organization?.members?.find((row:any)=>row.userId===identity.userId);
  if(organization&&(!member||organization.id!==identity.organizationId))throw new Error('team_forbidden');
  const allowed=!!member&&canInvite(member.role),invitations=allowed?await auth('list-invitations?organizationId='+encodeURIComponent(identity.organizationId)) as any[]:[];
  if(input.action==='team-invite'){
   if(!allowed)throw new Error('team_forbidden');
   if(typeof input.email!=='string'||input.email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))throw new Error('invalid_email');
   await auth('invite-member',{organizationId:identity.organizationId,email:input.email.trim().toLowerCase(),role:'member'});return {value:{ok:true},cookies};
  }
  if(input.action==='team-cancel'){
   if(!allowed||typeof input.invitationId!=='string'||!invitations.some(row=>row.id===input.invitationId&&row.organizationId===identity.organizationId&&pending(row)))throw new Error('invitation_unavailable');
   await auth('cancel-invitation',{invitationId:input.invitationId});return {value:{ok:true},cookies};
  }
  if(input.action!=='team-state')throw new Error('invalid_request');
  return {value:{organizationId:identity.organizationId,name:organization?.name??'',canInvite:allowed,accounts:accounts.map(({id,name})=>({id,name})),members:(organization?.members??[]).map((row:any)=>({id:row.id,name:row.user?.name??'Member',email:row.user?.email??'',role:row.role})),invitations:invitations.filter(pending).map(({id,email}:any)=>({id,email})),incoming:incoming.filter(pending).map(({id,organizationName}:any)=>({id,name:organizationName??'Workspace invitation'}))},cookies:[]};
 };
}
