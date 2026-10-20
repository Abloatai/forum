// Real Forum UI/OT; explicitly simulated Auth identities, delivery, Codex and Ablo storage.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {hostedService} from '../src/hosted/index.js';
import {openAuthority} from './fixtures/authority.js';
const store=randomUUID(),active:Record<string,string>={owner:'team',friend:'other',new:''};
const groups:Record<string,{name:string;members:string[]}>={team:{name:'Sample writing team',members:['owner']},other:{name:'Sample personal workspace',members:['friend']}};
const invitations:{id:string;organizationId:string;organizationName:string;email:string;status:string;expiresAt:string}[]=[];
let revoked=false,origin='',handler:ReturnType<typeof hostedService>;
const identify=(cookie:string)=>{const user=cookie.split('=')[1];if(!Object.hasOwn(active,user)||revoked&&user==='friend')throw new Error('auth_required');return {userId:user,name:user==='owner'?'Sample owner':'Sample collaborator',organizationId:active[user],workspace:active[user]};};
const teamFetch:typeof fetch=async(input,init)=>{
 const url=new URL(String(input)),path=url.pathname.split('/').at(-1),user=identify(new Headers(init?.headers).get('cookie')!).userId,body=init?.body?JSON.parse(String(init.body)):{};
 let value:unknown={ok:true};const group=groups[active[user]];
 if(path==='list')value=Object.entries(groups).filter(([,g])=>g.members.includes(user)).map(([id,g])=>({id,name:g.name}));
 else if(path==='list-user-invitations')value=invitations.filter(i=>i.email===user+'@example.test');
 else if(path==='get-full-organization')value={id:active[user],name:group.name,members:group.members.map(id=>({id,userId:id,role:id==='owner'?'owner':'member',user:{name:id==='owner'?'Sample owner':'Sample collaborator',email:id+'@example.test'}}))};
 else if(path==='list-invitations')value=invitations.filter(i=>i.organizationId===active[user]);
 else if(path==='invite-member')invitations.push({id:randomUUID(),organizationId:active[user],organizationName:group.name,email:body.email,status:'pending',expiresAt:new Date(Date.now()+600000).toISOString()});
 else if(path==='cancel-invitation')invitations.find(i=>i.id===body.invitationId)!.status='canceled';
 else if(path==='accept-invitation'){const invite=invitations.find(i=>i.id===body.invitationId&&i.email===user+'@example.test'&&i.status==='pending');assert.ok(invite);invite.status='accepted';groups[invite.organizationId].members.push(user);}
 else if(path==='create'){const id=randomUUID();groups[id]={name:body.name,members:[user]};value={id};}
 else if(path==='set-active'){assert.ok(groups[body.organizationId].members.includes(user));active[user]=body.organizationId;const headers=new Headers();headers.append('set-cookie','sample_one=updated; Path=/; HttpOnly');headers.append('set-cookie','sample_two=updated; Path=/; HttpOnly');return Response.json(value,{headers});}
 else throw new Error('Unexpected Auth call: '+path);
 return Response.json(value);
};
const server=createServer(async(req,res)=>{try{const url=new URL(req.url!,origin);if(url.pathname==='/api/rpc'){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const response=await handler(new Request(url,{method:req.method,headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));const cookies=response.headers.getSetCookie();res.writeHead(response.status,{...Object.fromEntries(response.headers),...(cookies.length?{'set-cookie':cookies}:{})});res.end(await response.text());return;}const name=url.pathname==='/app/'?'index.html':url.pathname.slice(5);if(!['index.html','index.js','style.css'].includes(name)){res.writeHead(404).end();return;}res.setHeader('content-type',({'.html':'text/html','.js':'application/javascript','.css':'text/css'} as Record<string,string>)[extname(name)]);res.end(await readFile(resolve('dist/browser',name)));}catch(error){console.error(error);res.writeHead(500).end();}});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
handler=hostedService({browserOrigin:origin,verifyBrowser:async cookie=>identify(cookie),teamFetch,authority:workspace=>openAuthority(store,undefined,workspace)});
const video=process.env.FORUM_BROWSER_VIDEO_DIR;if(video)await mkdir(video,{recursive:true});
const browser=await chromium.launch(video?{slowMo:100}:{});const chapters:{time:number;title:string}[]=[];const started=Date.now();
const chapter=(title:string)=>chapters.push({time:Math.round((Date.now()-started)/100)/10,title});
try{
 const owner=await browser.newContext({viewport:{width:1280,height:900},permissions:['clipboard-read','clipboard-write'],...(video?{recordVideo:{dir:video,size:{width:1280,height:900}}}:{})});
 const friend=await browser.newContext({viewport:{width:1280,height:900}}),fresh=await browser.newContext();
 for(const[context,user]of [[owner,'owner'],[friend,'friend'],[fresh,'new']] as const)await context.addCookies([{name:'better-auth.session_token',value:user,url:origin,httpOnly:true}]);
 const page=await owner.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 chapter('Sample accounts and simulated services: first-run onboarding');
 await page.goto(origin+'/app/');await page.getByText('Write with people and agents',{exact:true}).waitFor();if(video)await page.waitForTimeout(1400);await page.getByRole('button',{name:'Write without agents',exact:true}).click();
 await page.reload();await page.getByRole('button',{name:'New document',exact:true}).waitFor();assert.equal(await page.locator('#codex-dialog').isVisible(),false);
 await page.getByRole('button',{name:'New document',exact:true}).click();await page.locator('.tiptap').pressSequentially('Writing together.');await page.waitForFunction(()=>document.getElementById('status')?.textContent==='Synced');
 const id=await page.locator('#library [aria-current="true"]').getAttribute('data-document-id');assert.ok(id);
 chapter('Invite a collaborator and cancel an invitation');
 await page.getByRole('button',{name:'Members',exact:true}).click();await page.locator('#invite-email').fill('cancel@example.test');await page.locator('#invite-form button').click();await page.getByText('Invitation sent.',{exact:true}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByText('Invitation canceled.',{exact:true}).waitFor();
 await page.locator('#invite-email').fill('friend@example.test');await page.locator('#invite-form button').click();await page.getByText('Invitation sent.',{exact:true}).waitFor();assert.equal(await page.locator('#invite-email').inputValue(),'');
 if(video)await page.waitForTimeout(1200);
 await page.locator('#members-close').click();await page.getByRole('button',{name:'Share',exact:true}).click();await page.getByRole('button',{name:'Link copied',exact:true}).waitFor();const link=await page.evaluate(()=>navigator.clipboard.readText());assert.equal(link,origin+'/app/?document='+id);
 const recipient=await friend.newPage();recipient.on('pageerror',e=>errors.push(e.message));await recipient.goto(link);await recipient.getByRole('button',{name:'Write without agents',exact:true}).click();await recipient.getByText('This document is not in your current workspace.',{exact:false}).waitFor();
 await recipient.getByRole('button',{name:'Members',exact:true}).click();await recipient.getByRole('button',{name:'Accept invitation',exact:true}).click();await recipient.locator('.tiptap').getByText('Writing together.',{exact:true}).waitFor();
 const cookies=await friend.cookies();assert.ok(cookies.some(c=>c.name==='sample_one'));assert.ok(cookies.some(c=>c.name==='sample_two'));
 await recipient.getByRole('button',{name:'Members',exact:true}).click();await recipient.getByText('Sample writing team',{exact:true}).first().waitFor();assert.equal(await recipient.locator('#invite-form').isVisible(),false);await recipient.locator('#members-close').click();
 chapter('Shared document and chat after recipient accepts');
 await recipient.locator('.tiptap').press(process.platform==='darwin'?'Meta+ArrowDown':'Control+End');await recipient.locator('.tiptap').pressSequentially(' A second writer.');await page.waitForFunction(()=>document.querySelector('.tiptap')?.textContent?.includes('A second writer.'));
 await recipient.getByLabel('Message',{exact:true}).fill('Ready to review.');await recipient.getByRole('button',{name:'Send message',exact:true}).click();await page.getByRole('log').getByText('Ready to review.',{exact:true}).waitFor();
 if(video){await page.screenshot({path:resolve(video,'members-collaboration.png')});await page.waitForTimeout(1800);}
 const first=await fresh.newPage();await first.goto(origin+'/app/');await first.getByText('Choose a workspace',{exact:true}).waitFor();await first.keyboard.press('Escape');assert.equal(await first.locator('#members-dialog').isVisible(),true);await first.locator('#workspace-name').fill('Sample new workspace');await first.locator('#create-workspace-form button').click();await first.getByRole('button',{name:'Write without agents',exact:true}).click();await first.getByRole('button',{name:'New document',exact:true}).click();await first.locator('.tiptap').waitFor();
 revoked=true;await recipient.getByRole('button',{name:'Members',exact:true}).click();await recipient.getByRole('button',{name:'Sign in',exact:true}).waitFor();assert.deepEqual(errors,[]);
 await owner.close();await friend.close();await fresh.close();
 if(video)await writeFile(resolve(video,'chapters.json'),JSON.stringify(chapters,null,2));
 console.log('PASS: optional personal Codex onboarding, owner invite/cancel, role-limited controls, foreign-workspace document denial, verified recipient acceptance, both Set-Cookie headers, shared link/OT/chat across two users, new-account workspace creation and revocation. Auth, delivery, Codex and storage are simulated.');
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
