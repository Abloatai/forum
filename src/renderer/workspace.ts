import type {Request} from '../document/index.js';
type State={name:string;organizationId:string;canInvite:boolean;accounts:{id:string;name:string}[];members:{id:string;name:string;email:string;role:string}[];invitations:{id:string;email:string}[];incoming:{id:string;name:string}[]};
export function workspacePanel(request:(input:Request)=>Promise<unknown>){
 const get=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
 let required=false,busy=false;
 const status=(value:string)=>get('members-status').textContent=value;
 async function update(input:Request={action:'team-state'}){
  if(busy)return;busy=true;status('Loading…');
  try{
   if(input.action!=='team-state')await request(input);
   const state=await request({action:'team-state'}) as State;
   get('members-title').textContent=required?'Choose a workspace':state.name||'Members';
   get('members-access').hidden=!state.organizationId;
   get('invite-form').hidden=!state.canInvite;
   const select=get<HTMLSelectElement>('workspace-select');select.replaceChildren();
   for(const account of state.accounts){const option=document.createElement('option');option.value=account.id;option.textContent=account.name;select.append(option);}
   select.value=state.organizationId;get('workspace-switch').hidden=!state.accounts.length;
   const members=get('member-list');members.replaceChildren();
   for(const member of state.members){const row=document.createElement('div');row.className='member-row';const name=document.createElement('strong');name.textContent=member.name;const detail=document.createElement('span');detail.textContent=member.email;const role=document.createElement('small');role.textContent=member.role;row.append(name,detail,role);members.append(row);}
   const invitations=get('pending-invitations');invitations.replaceChildren();
   for(const invitation of state.invitations){const row=document.createElement('div');row.className='invitation-row';const email=document.createElement('span');email.textContent=invitation.email;const pending=document.createElement('small');pending.textContent='Invited';const button=document.createElement('button');button.textContent='Cancel';button.onclick=()=>{void update({action:'team-cancel',invitationId:invitation.id});};row.append(email,pending,button);invitations.append(row);}
   const incoming=get('incoming-invitations');incoming.replaceChildren();
   for(const invitation of state.incoming){const row=document.createElement('div');row.className='invitation-row';const name=document.createElement('span');name.textContent=invitation.name;const accept=document.createElement('button');accept.textContent='Accept invitation';accept.onclick=()=>{void update({action:'team-accept',invitationId:invitation.id});};row.append(name,accept);incoming.append(row);}
   if(input.action==='team-invite')get<HTMLInputElement>('invite-email').value='';
   get<HTMLDetailsElement>('new-workspace').open=required&&!state.accounts.length&&!state.incoming.length;
   status(input.action==='team-invite'?'Invitation sent.':input.action==='team-cancel'?'Invitation canceled.':'');
  }catch{status('Could not update the workspace. Check your access and try again.');}
  finally{busy=false;}
 }
 get('invite-form').onsubmit=event=>{event.preventDefault();const email=get<HTMLInputElement>('invite-email').value;void update({action:'team-invite',email});};
 get('create-workspace-form').onsubmit=event=>{event.preventDefault();void update({action:'team-create',name:get<HTMLInputElement>('workspace-name').value});};
 get('workspace-switch').onsubmit=event=>{event.preventDefault();void update({action:'team-switch',organizationId:get<HTMLSelectElement>('workspace-select').value});};
 get('members-close').onclick=()=>get<HTMLDialogElement>('members-dialog').close();
 get('members-dialog').addEventListener('cancel',event=>{if(required)event.preventDefault();});
 return {open(needsWorkspace=false){required=needsWorkspace;get('members-close').hidden=required;get<HTMLDialogElement>('members-dialog').showModal();void update();}};
}
