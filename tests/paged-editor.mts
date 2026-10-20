// Actual compiled editor and Codex connection UI; identity, storage and native login are simulated.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {hostedService} from '../src/hosted/index.js';
import {personalCodex} from '../src/codex/index.js';
import type {Store,Saved} from '../src/codex/storage.js';
import {openAuthority} from './fixtures/authority.js';
import {documentTool} from '../src/agent/tools.js';
const store=randomUUID(),id=randomUUID(),seed=openAuthority(store,undefined,'sample-team');
await seed.request({action:'create',id,title:'Writing together — sample document'});
for(let version=0;version<48;version++)await documentTool(input=>seed.request(input),id,'seed','append_paragraph',{version,text:`Paragraph ${version+1}. A shared place for a few words.`});
const rows=new Map<string,Saved>(),credentials:Store={async read(user){return rows.get(user)??{value:{generation:''}};},async write(user,value){const next={value};rows.set(user,next);return next;}};
let approve!:(value:boolean)=>void;const completed=new Promise<boolean>(done=>approve=done),jobs:Promise<void>[]=[];
const codex=personalCodex(credentials,async()=>({home:'unused',completed,close:async()=>{},snapshot:async()=>'',request:async<T,>()=>({verificationUrl:'https://auth.openai.com/codex/device',userCode:'SAMPLE-CODE'} as T),read:async()=>({auth:'synthetic-private-auth',view:{email:'sample@example.test',plan:'plus',models:[{id:'sample-codex',name:'Sample Codex',isDefault:true}]}})}),p=>jobs.push(p));
let origin='',handler:ReturnType<typeof hostedService>;
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url!,origin);if(url.pathname==='/api/rpc'){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const response=await handler(new Request(url,{method:req.method,headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;}
 const name=url.pathname==='/app/'?'index.html':url.pathname.slice(5);if(!['index.html','index.js','style.css'].includes(name)){res.writeHead(404).end();return;}
 res.setHeader('content-type',({'.html':'text/html','.js':'application/javascript','.css':'text/css'} as Record<string,string>)[extname(name)]);res.end(await readFile(resolve('dist/browser',name)));
}catch{res.writeHead(500).end();}});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
handler=hostedService({codex,browserOrigin:origin,verifyBrowser:async()=>({userId:'sample-user',name:'Sample member',organizationId:'sample-team',workspace:'sample-team'}),authority:workspace=>openAuthority(store,actor=>codex.agent(actor),workspace)});
const directory=process.env.FORUM_BROWSER_VIDEO_DIR;if(directory)await mkdir(directory,{recursive:true});
const browser=await chromium.launch();try{
 const context=await browser.newContext({viewport:{width:1440,height:900},...(directory?{recordVideo:{dir:directory,size:{width:1440,height:900}}}:{})});await context.addCookies([{name:'better-auth.session_token',value:'sample',url:origin,httpOnly:true}]);
 const page=await context.newPage(),errors:string[]=[],started=Date.now(),chapters:{time:number;title:string}[]=[];const chapter=(title:string)=>chapters.push({time:(Date.now()-started)/1000,title});page.on('pageerror',error=>errors.push(error.message));
 chapter('Paged document — simulated services');await page.goto(origin+'/app/');if(directory)await page.evaluate(()=>{const label=document.createElement('div');label.textContent='Local preview · simulated identity, storage and Codex approval';label.style.cssText='position:fixed;z-index:10000;left:460px;top:8px;background:#171717;color:white;padding:6px 12px;border-radius:6px;font:12px sans-serif;pointer-events:none';document.body.append(label);});await page.locator(`#library [data-document-id="${id}"]`).click();await page.waitForFunction(()=>document.getElementById('page-count')?.textContent!=='1 page');await page.waitForTimeout(200);
 assert.match(await page.locator('#paper').evaluate(node=>getComputedStyle(node).backgroundImage),/linear-gradient/);assert.equal(await page.locator('.pagination-page-break').first().evaluate(node=>getComputedStyle(node).borderTopStyle),'none');
 const paragraphs=page.locator('.tiptap p'),count=await paragraphs.count();assert.ok(count>=48);
 chapter('Scroll and focus the writing area');await paragraphs.nth(29).click();await page.waitForTimeout(200);assert.equal(await page.locator('#writing-focus').isVisible(),true);
 const positions=page.evaluate<number[]>(`(async()=>{const values=[];const start=performance.now(),canvas=document.getElementById('canvas');await new Promise(done=>{function frame(){values.push(canvas.scrollTop);if(performance.now()-start<1400)requestAnimationFrame(frame);else done();}frame();});return values;})()`);
 chapter('Type without viewport jumps');await page.keyboard.type(' Keep writing together.',{delay:25});const samples=await positions;assert.ok(Math.max(...samples)-Math.min(...samples)<=1,`Typing moved viewport: ${Math.min(...samples)}..${Math.max(...samples)}`);
 if(directory){await page.screenshot({path:resolve(directory,'pages-focus.png')});await page.waitForTimeout(1200);}
 await page.getByLabel('Message',{exact:true}).focus();assert.equal(await page.locator('#writing-focus').isVisible(),false);
 const top=await page.locator('#canvas').evaluate(node=>node.scrollTop);await page.setViewportSize({width:1340,height:900});await page.waitForTimeout(250);assert.ok(Math.abs(await page.locator('#canvas').evaluate(node=>node.scrollTop)-top)<=1,'Resize must not scroll back to the editor selection.');
 chapter('Personal Codex connection — simulated approval');await page.getByRole('button',{name:'Account',exact:true}).click();await page.getByRole('button',{name:'Codex account',exact:true}).click();await page.getByRole('button',{name:'Connect Codex',exact:true}).click();await page.getByText('SAMPLE-CODE',{exact:true}).waitFor();await page.waitForTimeout(1000);approve(true);await Promise.all(jobs);await page.getByText('Connected as sample@example.test. Uses your ChatGPT plan.',{exact:true}).waitFor();await page.waitForTimeout(1000);if(directory)await page.screenshot({path:resolve(directory,'personal-connection.png')});
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByRole('button',{name:'Connect Codex',exact:true}).waitFor();await page.getByRole('button',{name:'Close Codex account',exact:true}).click();await page.getByLabel('Document layout').selectOption('flow');await page.waitForFunction(()=>document.body.dataset.layout==='flow');assert.equal(await page.locator('#paper').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(255, 255, 255)');assert.equal(await page.locator('.pagination-page-break').count(),0);
 assert.deepEqual(errors,[]);if(directory){await page.screenshot({path:resolve(directory,'result.png')});await writeFile(resolve(directory,'chapters.json'),JSON.stringify(chapters));}const video=page.video();await context.close();if(directory)await video!.saveAs(resolve(directory,'forum-pages-personal-codex.webm'));
 console.log('PASS: page gutters, steady viewport while typing and resizing, focus cue, white flowing mode and personal connection/approval/disconnect UI (simulated services).');
}finally{approve(false);await browser.close();await seed.close();await new Promise<void>(done=>server.close(()=>done()));}
