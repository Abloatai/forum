// Native UI against an explicit local issuer/Ablo contract double, not a live login.
import {_electron as electron} from 'playwright';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {hostedService} from '../src/hosted/index.js';
import {openAuthority} from './fixtures/authority.js';
const profile=await mkdtemp(join(tmpdir(),'forum-native-auth-'));
const identity={userId:'synthetic-member',organizationId:'synthetic-team',workspace:'synthetic-team',name:'Sample member'};
const service=hostedService({verify:async token=>{if(token!=='synthetic-session')throw new Error('auth_required');return identity;},authority:workspace=>openAuthority(profile,undefined,workspace)});
const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const response=await service(new Request('http://127.0.0.1/api/rpc',{method:req.method,headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const site=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
const env={...process.env,LOBBY_DOCS_PROFILE:profile,FORUM_API_URL:site};delete env.ABLO_API_KEY;delete env.ELECTRON_RUN_AS_NODE;
let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
async function launch(){app=await electron.launch({...(process.env.FORUM_TEST_EXECUTABLE?{executablePath:process.env.FORUM_TEST_EXECUTABLE,args:[]}:{args:['.']}),env,...(process.env.FORUM_NATIVE_VIDEO_DIR?{recordVideo:{dir:process.env.FORUM_NATIVE_VIDEO_DIR,size:{width:1280,height:900}}}:{})});app.context().setDefaultTimeout(15000);return app.firstWindow();}
try{
  let page=await launch();await page.getByRole('button',{name:'Continue with Google'}).waitFor();
  await page.getByRole('button',{name:'Continue with email'}).waitFor();
  if(process.env.FORUM_NATIVE_VIDEO_DIR)await page.waitForTimeout(1200);
  assert.equal(await page.locator('.workspace').isVisible(),false);
  await assert.rejects(page.evaluate(()=>window.lobbyDocs.create('Unauthenticated document')),/auth_required/);
  await app!.evaluate(({shell})=>{
    const state=globalThis as any;state.savedFetch=globalThis.fetch;state.savedOpen=shell.openExternal;state.opened=[];
    state.exchanges=[];
    globalThis.fetch=async(input,init)=>{
      if(String(input).endsWith('/electron/token')){state.exchanges.push(JSON.parse(String(init?.body)));return Response.json({token:'synthetic-session'});}
      return state.savedFetch(input,init);
    };
    shell.openExternal=async url=>{state.opened.push(url);};
  });
  await Promise.all([page.evaluate(()=>window.lobbyDocs.signIn()),page.evaluate(()=>window.lobbyDocs.signIn())]);
  await page.waitForTimeout(100);
  const opened=await app!.evaluate(()=> (globalThis as any).opened);
  assert.equal(opened.length,1);const target=new URL(opened[0]);assert.equal(target.pathname,'/signin/desktop/');assert.equal(target.searchParams.get('code_challenge_method'),'S256');
  assert.equal((await page.evaluate(()=>window.lobbyDocs.authState())).code,'');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Continue with Google'}).waitFor();
  await page.getByRole('button',{name:'Continue with Google'}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).waitFor();
  const started=new URL((await app!.evaluate(()=>(globalThis as any).opened)).at(-1));
  const callback='com.ablo.forum://auth/callback#token='+Buffer.from(JSON.stringify({state:started.searchParams.get('state'),identifier:'s'.repeat(32)})).toString('base64url');
  await app!.evaluate(({app},url)=>{app.emit('open-url',{preventDefault(){}},url);},callback);
  await page.getByRole('button',{name:'New document',exact:true}).waitFor();
  assert.equal((await app!.evaluate(()=>(globalThis as any).exchanges)).length,1);
  await app!.evaluate(({shell})=>{const state=globalThis as any;globalThis.fetch=state.savedFetch;shell.openExternal=state.savedOpen;});
  const encrypted=await app!.evaluate(({safeStorage},value)=>safeStorage.encryptString(JSON.stringify(value)).toString('base64'),{binding:site,token:'synthetic-session',identity});
  await app!.close();app=undefined;
  await writeFile(join(profile,'auth-session.bin'),Buffer.from(encrypted,'base64'),{mode:0o600});
  page=await launch();await page.getByRole('button',{name:'New document',exact:true}).click();
  const editor=page.locator('.tiptap');await editor.pressSequentially('A synthetic sign-in check.');
  await page.waitForFunction(()=>document.getElementById('status')?.textContent==='Synced');
  await app!.close();app=undefined;
  page=await launch();await page.locator('#library button').first().click();await page.locator('.tiptap').getByText('A synthetic sign-in check.').waitFor();
  assert.equal((await readFile(join(profile,'auth-session.bin'))).includes('synthetic-session'),false);
  await page.getByRole('button',{name:'Account',exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('button',{name:'Continue with Google'}).waitFor();
  assert.equal(await page.locator('.workspace').isVisible(),false);
  if(process.env.FORUM_NATIVE_VIDEO_DIR)await page.waitForTimeout(1000);
  await assert.rejects(readFile(join(profile,'auth-session.bin')),{code:'ENOENT'});
  assert.deepEqual(await page.evaluate(()=>window.lobbyDocs.list()),[]);
  await assert.rejects(page.evaluate(()=>window.lobbyDocs.create('After logout')),/auth_required/);
  await app!.evaluate(()=>{
    const state=globalThis as any;state.emailRequests=[];state.savedFetch=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const url=String(input);if(url.startsWith('https://auth.abloatai.com/')){const body=JSON.parse(String(init?.body??'{}'));state.emailRequests.push({url,body});return url.endsWith('/sign-in/email-otp')?body.otp==='123456'?Response.json({token:'synthetic-session'}):Response.json({error:'invalid_code'},{status:400}):Response.json({success:true});}
      return state.savedFetch(input,init);
    };
  });
  await page.getByRole('textbox',{name:'Email address',exact:true}).fill('sample@example.test');
  await page.getByRole('button',{name:'Continue with email',exact:true}).click();
  await page.getByRole('textbox',{name:'Email sign-in code',exact:true}).fill('000000');await page.getByRole('button',{name:'Verify code',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Invalid or expired code'}).waitFor();
  if(process.env.FORUM_NATIVE_VIDEO_DIR)await page.waitForTimeout(800);
  await page.getByRole('textbox',{name:'Email sign-in code',exact:true}).fill('123456');await page.getByRole('button',{name:'Verify code',exact:true}).click();
  await page.getByRole('button',{name:'New document',exact:true}).waitFor();
  assert.equal((await app!.evaluate(()=>(globalThis as any).emailRequests)).filter((request:any)=>request.url.endsWith('send-verification-otp')).length,1);
  console.log('PASS: native Google/email controls, one Google launch, S256 code exchange, email code retry, OS-encrypted session restore, document editing, restart and sign-out. Explicit simulated issuer and in-memory Ablo authority; no real browser or email opened.');
}finally{await app?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(profile,{recursive:true,force:true});}
