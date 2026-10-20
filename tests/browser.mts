// Actual browser editor; explicit simulated issuer and in-memory Ablo contract double.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {hostedService} from '../src/hosted/index.js';
import {connectedCodex} from './fixtures/codex.js';
import {openAuthority} from './fixtures/authority.js';
const store=randomUUID();let origin='',revoked=false;
// The service captures its allowed origin at construction, after the port is known.
let handler:ReturnType<typeof hostedService>;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url!,origin);
    if(url.pathname==='/api/rpc'){
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const response=await handler(new Request(url,{method:req.method,headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
    }
    const name=url.pathname==='/app/'?'index.html':url.pathname.slice('/app/'.length);
    if(!['index.html','index.js','style.css'].includes(name)){res.writeHead(404).end();return;}
    res.setHeader('content-type',({'.html':'text/html','.js':'application/javascript','.css':'text/css'} as Record<string,string>)[extname(name)]);res.end(await readFile(resolve('dist/browser',name)));
  }catch(error){console.error(error);res.writeHead(500).end();}
});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
handler=hostedService({codex:connectedCodex,browserOrigin:origin,verifyBrowser:async cookie=>{
  if(cookie!=='better-auth.session_token=sample-session'||revoked)throw new Error('auth_required');
  return {userId:'sample-user',name:'Sample member',organizationId:'sample-team',workspace:'sample-team'};
},authority:workspace=>openAuthority(store,undefined,workspace)});
const video=process.env.FORUM_BROWSER_VIDEO_DIR;if(video)await mkdir(video,{recursive:true});
const browser=await chromium.launch();
try{
  const context=await browser.newContext({viewport:{width:1280,height:900},...(video?{recordVideo:{dir:video,size:{width:1280,height:900}}}:{})});
  await context.route('https://www.abloatai.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>Sample shared Google/email sign-in page</h1>'}));
  await context.route('https://auth.abloatai.com/api/auth/sign-out',async route=>{
    if(route.request().method()==='POST')await context.clearCookies({name:'better-auth.session_token'});
    await route.fulfill({headers:{'access-control-allow-origin':origin,'access-control-allow-credentials':'true','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'},json:{success:true}});
  });
  await context.addCookies([{name:'better-auth.session_token',value:'sample-session',url:origin,httpOnly:true}]);
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  let releaseSession!:()=>void,releaseList!:()=>void,sessionReached!:()=>void,listReached!:()=>void;
  const sessionGate=new Promise<void>(done=>releaseSession=done),listGate=new Promise<void>(done=>releaseList=done);
  const sessionStarted=new Promise<void>(done=>sessionReached=done),listStarted=new Promise<void>(done=>listReached=done);
  let firstSession=true,firstList=true;
  await page.route('**/api/rpc',async route=>{
    const action=route.request().postDataJSON().action;
    if(action==='session'&&firstSession){firstSession=false;sessionReached();await sessionGate;}
    if(action==='list'&&firstList){firstList=false;listReached();await listGate;}
    await route.continue();
  });
  await page.goto(origin+'/app/');await sessionStarted;
  assert.equal(await page.getByRole('status').filter({hasText:'Opening Forum'}).isVisible(),true);
  assert.equal(await page.locator('.workspace').isVisible(),false);
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.bootstrap-spinner').evaluate(node=>getComputedStyle(node).animationName),'none');
  releaseSession();await listStarted;
  assert.equal(await page.locator('#bootstrap').isVisible(),true,'Wait for the document list after authentication.');
  releaseList();await page.getByRole('button',{name:'New document',exact:true}).click();
  assert.equal(await page.locator('#bootstrap').isVisible(),false);
  const failed=await context.newPage();
  await failed.route('**/api/rpc',route=>route.request().postDataJSON().action==='list'?route.fulfill({status:503,json:{error:'Sample document list unavailable'}}):route.continue());
  await failed.goto(origin+'/app/');await failed.getByText('Sample document list unavailable',{exact:true}).waitFor();
  assert.equal(await failed.locator('#bootstrap').isVisible(),false,'A failed bootstrap must reveal the error, not leave a spinner.');
  await failed.close();
  await page.locator('.tiptap').pressSequentially('A shared browser document.');
  await page.waitForFunction(()=>document.getElementById('status')?.textContent==='Synced');
  assert.equal(await page.getByRole('button',{name:'Sign in',exact:true}).isVisible(),false);
  const id=await page.locator('#library [aria-current="true"]').getAttribute('data-document-id');assert.ok(id);
  const second=await context.newPage();await second.goto(origin+'/app/');await second.locator(`#library [data-document-id="${id}"]`).click();
  await second.locator('.tiptap').getByText('A shared browser document.',{exact:true}).waitFor();
  await second.locator('.tiptap').press(process.platform==='darwin'?'Meta+ArrowDown':'Control+End');await second.locator('.tiptap').pressSequentially(' Written together.');
  await page.waitForFunction(()=>document.querySelector('.tiptap')?.textContent?.includes('Written together.'));
  const clients=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('forum:draft:')).map(key=>JSON.parse(localStorage.getItem(key)!).clientID));assert.equal(new Set(clients).size,2);
  await page.getByLabel('Message',{exact:true}).fill('Two tabs, one document.');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await second.getByRole('log').getByText('Two tabs, one document.',{exact:true}).waitFor();
  await page.route('**/api/rpc',route=>route.request().postDataJSON().action==='session'?route.continue():route.abort());
  await page.locator('.tiptap').press(process.platform==='darwin'?'Meta+ArrowDown':'Control+End');await page.locator('.tiptap').pressSequentially(' Kept after closing the tab.');
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(key=>key.startsWith('forum:draft:')&&JSON.parse(localStorage.getItem(key)!).steps.length>0)),true);
  await page.close();
  const recovered=await context.newPage();recovered.on('pageerror',error=>errors.push(error.message));await recovered.goto(origin+'/app/');await recovered.locator(`#library [data-document-id="${id}"]`).click();
  await recovered.locator('.tiptap').getByText(/Kept after closing the tab/).waitFor();
  await second.waitForFunction(()=>document.querySelector('.tiptap')?.textContent?.includes('Kept after closing the tab.'));
  if(video){await recovered.screenshot({path:resolve(video,'browser-editor.png')});await recovered.waitForTimeout(1500);}
  await recovered.getByRole('button',{name:'Account',exact:true}).click();await recovered.getByRole('button',{name:'Sign out',exact:true}).click();await recovered.getByRole('button',{name:'Sign in',exact:true}).waitFor();
  assert.equal(await recovered.locator('.workspace').isVisible(),false);
  assert.equal((await context.cookies()).some(cookie=>cookie.name==='better-auth.session_token'),false);
  await recovered.getByRole('button',{name:'Sign in',exact:true}).click();
  await context.addCookies([{name:'better-auth.session_token',value:'sample-session',url:origin,httpOnly:true}]);
  await recovered.getByRole('button',{name:'New document',exact:true}).waitFor();
  revoked=true;await recovered.waitForTimeout(11000);await recovered.getByRole('button',{name:'Sign in',exact:true}).waitFor();
  assert.deepEqual(errors,[]);await context.close();
  const anonymous=await browser.newContext();await anonymous.route('https://www.abloatai.com/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Sample shared Google/email sign-in page</h1>'}));
  const signedOut=await anonymous.newPage();await signedOut.goto(origin+'/app/');
  const popup=signedOut.waitForEvent('popup');await signedOut.getByRole('button',{name:'Sign in',exact:true}).click();const login=await popup;await login.waitForURL('https://www.abloatai.com/signin?next=%2Fapp');
  assert.equal(login.url().includes('/cli'),false);await anonymous.close();
  console.log('PASS: delayed session/list loading, reduced motion, bootstrap failure, browser cookie SSO, editor, two independent OT clients, shared chat, closed-tab pending recovery, shared issuer sign-out, fresh sign-in/re-entry, revocation, and normal shared sign-in (simulated issuer and storage; sign-in page intercepted).');
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
