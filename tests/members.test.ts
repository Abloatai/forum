import {test} from 'node:test';
import assert from 'node:assert/strict';
import {membersService} from '../src/members/index.js';
import {hostedService} from '../src/hosted/index.js';
import {authAuthority} from '../src/auth/index.js';
const identity={userId:'owner',name:'Owner',organizationId:'team',workspace:'team'};
function fixture(role='owner'){
 const calls:{path:string;body:any;headers:Headers}[]=[],future=new Date(Date.now()+60000).toISOString();let active='team';
 const fetcher:typeof fetch=async(input,init)=>{const path=new URL(String(input)).pathname.split('/').at(-1)!,body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path,body,headers:new Headers(init?.headers)});let result:any;
  if(path==='list')result=[{id:'team',name:'Team'},{id:'other-team',name:'Other team'}];
  else if(path==='list-user-invitations')result=[{id:'incoming',organizationId:'incoming-team',organizationName:'Friend team',status:'pending',expiresAt:future},{id:'expired',status:'pending',expiresAt:'2000-01-01'}];
  else if(path==='get-full-organization')result={id:active,name:'Team',members:[{id:'membership',userId:'owner',role,user:{name:'Owner',email:'owner@example.test'}}]};
  else if(path==='list-invitations')result=[{id:'pending',organizationId:'team',email:'friend@example.test',role:'member',status:'pending',expiresAt:future}];
  else if(path==='create')result={id:'created'};
  else if(path==='set-active'){active=body.organizationId;return Response.json({ok:true},{headers:{'set-cookie':'sample.workspace=updated; Path=/; Secure; HttpOnly'}});}
  else result={ok:true};
  return Response.json(result);
 };
 return {calls,request:membersService(fetcher)};
}
test('members list uses verified current workspace, exposes pending invitations only to admins, and invites only as member',async()=>{
 const {request,calls}=fixture(),credential={cookie:'sample-session'};
 const state=(await request({action:'team-state'},identity,credential,'https://forum.abloatai.com')).value as any;assert.equal(state.canInvite,true);assert.equal(state.members[0].email,'owner@example.test');assert.deepEqual(state.incoming,[{id:'incoming',name:'Friend team'}]);
 await request({action:'team-invite',email:' Friend@Example.Test ',role:'owner',organizationId:'foreign-team'},identity,credential,'https://forum.abloatai.com');
 const invite=calls.find(call=>call.path==='invite-member')!;assert.deepEqual(invite.body,{organizationId:'team',email:'friend@example.test',role:'member'});assert.equal(invite.headers.get('origin'),'https://forum.abloatai.com');assert.equal(invite.headers.get('cookie'),'sample-session');
 await assert.rejects(request({action:'team-invite',email:'bad\n@example.test'},identity,credential,'https://forum.abloatai.com'),/invalid_email/);
});
test('ordinary members cannot invite or cancel, and cross-workspace invitation IDs are refused',async()=>{
 const basic=fixture('member'),credential={authorization:'Bearer sample'};const state=(await basic.request({action:'team-state'},identity,credential,'https://forum.abloatai.com')).value as any;assert.equal(state.canInvite,false);assert.deepEqual(state.invitations,[]);assert.ok(!basic.calls.some(call=>call.path==='list-invitations'));
 await assert.rejects(basic.request({action:'team-invite',email:'friend@example.test'},identity,credential,'https://forum.abloatai.com'),/team_forbidden/);await assert.rejects(basic.request({action:'team-cancel',invitationId:'pending'},identity,credential,'https://forum.abloatai.com'),/invitation_unavailable/);
 const admin=fixture('admin');await assert.rejects(admin.request({action:'team-cancel',invitationId:'foreign'},identity,credential,'https://forum.abloatai.com'),/invitation_unavailable/);await admin.request({action:'team-cancel',invitationId:'pending'},identity,credential,'https://forum.abloatai.com');assert.deepEqual(admin.calls.find(call=>call.path==='cancel-invitation')!.body,{invitationId:'pending'});
});
test('acceptance checks incoming invitations and forwards active-workspace cookies; switches prove membership first',async()=>{
 const {request,calls}=fixture(),credential={cookie:'sample'};await assert.rejects(request({action:'team-accept',invitationId:'expired'},identity,credential,'https://forum.abloatai.com'),/invitation_unavailable/);
 const accepted=await request({action:'team-accept',invitationId:'incoming'},identity,credential,'https://forum.abloatai.com');assert.deepEqual(calls.find(call=>call.path==='set-active')!.body,{organizationId:'incoming-team'});assert.equal(accepted.cookies.length,1);
 await assert.rejects(request({action:'team-switch',organizationId:'foreign'},identity,credential,'https://forum.abloatai.com'),/team_forbidden/);
 await request({action:'team-switch',organizationId:'other-team'},identity,credential,'https://forum.abloatai.com');
});
test('workspace creation validates its name and only activates the organization Auth created',async()=>{
 const {request,calls}=fixture(),credential={cookie:'sample'};await assert.rejects(request({action:'team-create',name:' '},identity,credential,'https://forum.abloatai.com'),/invalid_workspace_name/);
 await request({action:'team-create',name:' New workspace '},identity,credential,'https://forum.abloatai.com');assert.equal(calls.find(call=>call.path==='create')!.body.name,'New workspace');assert.deepEqual(calls.at(-1)!.body,{organizationId:'created'});
});
test('an authenticated unassigned profile can bootstrap but cannot read or create documents',async()=>{
 const profile={...identity,organizationId:'',workspace:''};let opened=false;
 const service=hostedService({verify:async()=>profile,authority:()=>{opened=true;throw new Error('must not open');}});
 const send=(action:string)=>service(new Request('https://forum.abloatai.com/api/rpc',{method:'POST',headers:{authorization:'Bearer sample'},body:JSON.stringify({action})}));
 const session=await send('session');assert.equal(session.status,200);assert.equal((await session.json()).needsWorkspace,true);
 assert.equal((await send('list')).status,401);assert.equal((await send('create')).status,401);assert.equal(opened,false);
});
test('unassigned issuer sessions are admitted only by the setup verifier, and upstream failures stay sanitized',async()=>{
 const fetcher:typeof fetch=async input=>Response.json(String(input).includes('get-session')?{user:{id:'new',name:'New'},session:{}}:[]);
 await assert.rejects(authAuthority({url:'https://auth.abloatai.com'},fetcher)('sample'),/auth_required/);
 const profile=await authAuthority({url:'https://auth.abloatai.com'},fetcher,'bearer',true)('sample');assert.equal(profile.organizationId,'');assert.equal(profile.userId,'new');
 const bad=membersService(async()=>Response.json({private:'never exposed'},{status:503}));await assert.rejects(bad({action:'team-state'},identity,{cookie:'sample'},'https://forum.abloatai.com'),/^Error: team_unavailable$/);
});
test('a revoked active workspace cannot grant document access but setup can recover another proved membership',async()=>{
 const fetcher:typeof fetch=async input=>{const path=String(input);if(path.includes('get-session'))return Response.json({user:{id:'owner'},session:{activeOrganizationId:'revoked'}});if(path.includes('get-active-member'))return Response.json({}, {status:403});if(path.includes('organization/list'))return Response.json([{id:'remaining'}]);return Response.json({members:[{userId:'owner',organizationId:'remaining',role:'member'}]});};
 await assert.rejects(authAuthority({url:'https://auth.abloatai.com'},fetcher)('sample'),/auth_required/);
 assert.equal((await authAuthority({url:'https://auth.abloatai.com'},fetcher,'bearer',true)('sample')).organizationId,'remaining');
 const unavailable:typeof fetch=async input=>String(input).includes('get-session')?Response.json({user:{id:'owner'},session:{activeOrganizationId:'revoked'}}):Response.json({}, {status:503});
 await assert.rejects(authAuthority({url:'https://auth.abloatai.com'},unavailable,'bearer',true)('sample'),/auth_unavailable/);
});
test('team switching bypasses an old workspace header only after fresh issuer proof and ordinary requests refresh the new scope',async()=>{
 let active='team',proofs=0;
 const service=hostedService({verifyBrowser:async()=>{proofs++;return {...identity,organizationId:active,workspace:active};},teamFetch:async(input,init)=>{if(String(input).endsWith('set-active'))active=JSON.parse(String(init?.body)).organizationId;return Response.json(String(input).endsWith('/list')?[{id:'team',name:'Team'},{id:'other-team',name:'Other'}]:{ok:true},{headers:String(input).endsWith('set-active')?[['set-cookie','sample=changed; Path=/']]:[]});},authority:()=>({workspace:async()=>active,request:async()=>[]} as any)});
 const send=(action:string,extra:object={})=>service(new Request('https://forum.abloatai.com/api/rpc',{method:'POST',headers:{origin:'https://forum.abloatai.com',cookie:'better-auth.session_token=sample','x-forum-workspace':action==='list'&&active==='other-team'?'other-team':'team'},body:JSON.stringify({action,...extra})}));
 assert.equal((await send('list')).status,200);const before=proofs;
 const switched=await send('team-switch',{organizationId:'other-team'});assert.equal(switched.status,200);assert.equal(switched.headers.getSetCookie().length,1);assert.ok(proofs>before);
 assert.equal((await send('list')).status,200);assert.ok(proofs>before+1,'The old leased identity must be replaced by a fresh proof for the new scope.');
});
