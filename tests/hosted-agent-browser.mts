// Actual browser UI and SDK loop; explicitly simulated identity, provider and Ablo storage.
import {chromium} from 'playwright';
import {MockLanguageModelV3} from 'ai/test';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {hostedService} from '../src/hosted/index.js';
import {openAuthority} from './fixtures/authority.js';
import {markdownReply,checkMarkdown} from './fixtures/markdown.js';

const work:Promise<void>[]=[],id=randomUUID(),usage={inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}};
const model:MockLanguageModelV3=new MockLanguageModelV3({doGenerate:async options=>{
 const step=model.doGenerateCalls.length;await new Promise(resolve=>setTimeout(resolve,600));
 const read=options.prompt.flatMap((message:any)=>message.role==='tool'?message.content:[]).filter((part:any)=>part.type==='tool-result'&&part.toolName==='read_document').at(-1) as any;
 const content=step===1?[{type:'tool-call',toolCallId:randomUUID(),toolName:'read_document',input:'{}'}]:step===2?[{type:'tool-call',toolCallId:randomUUID(),toolName:'append_paragraph',input:JSON.stringify({version:read.output.value.version,text:'A paragraph added by the hosted agent.'})}]:[{type:'text',text:markdownReply}];
 return {content,finishReason:{unified:step<3?'tool-calls':'stop',raw:step<3?'tool_use':'end_turn'},usage,warnings:[]} as any;
}});
const authority=openAuthority(id,{provider:()=>model,models:[{id:'fixture/model',name:'Sample model (simulated)',isDefault:true}],waitUntil:p=>work.push(p)});
let origin='',handler:ReturnType<typeof hostedService>;
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url!,origin);
  if(url.pathname==='/api/rpc'){
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const response=await handler(new Request(url,{method:req.method,headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  const name=url.pathname==='/app/'?'index.html':url.pathname.slice(5);if(!['index.html','index.js','style.css'].includes(name)){res.writeHead(404).end();return;}
  res.setHeader('content-type',({'.html':'text/html','.js':'application/javascript','.css':'text/css'} as Record<string,string>)[extname(name)]);res.end(await readFile(resolve('dist/browser',name)));
 }catch{res.writeHead(500).end();}
});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
handler=hostedService({browserOrigin:origin,verifyBrowser:async()=>({userId:'sample-user',organizationId:'sample-team',workspace:'sample-team',name:'Sample member'}),authority:()=>authority});
const video=process.env.FORUM_AGENT_VIDEO_DIR;if(video)await mkdir(video,{recursive:true});const browser=await chromium.launch();
try{
 const context=await browser.newContext({viewport:{width:1280,height:900},...(video?{recordVideo:{dir:video,size:{width:1280,height:900}}}:{})});
 await context.addCookies([{name:'better-auth.session_token',value:'sample-session',url:origin,httpOnly:true}]);
 await context.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{const label=document.createElement('div');label.textContent='Local demo · simulated sign-in, model and storage';label.style.cssText='position:fixed;bottom:8px;left:8px;z-index:10000;font:11px system-ui;color:#666;background:white;padding:5px';document.body.append(label);}));
 const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/app/');await page.getByRole('button',{name:'Write without agents',exact:true}).click();await page.getByRole('button',{name:'New document',exact:true}).click();
 await page.locator('.tiptap').pressSequentially('We are writing together.');await page.waitForFunction(()=>document.getElementById('status')?.textContent==='Synced');
 const input=page.getByLabel('Message',{exact:true});await input.fill('/model ');await page.getByRole('option',{name:/Sample model/}).waitFor();if(video)await page.waitForTimeout(900);await input.press('Enter');
 await input.fill('Add a paragraph and keep our original text.');await page.getByRole('button',{name:'Send message',exact:true}).click();
 await checkMarkdown(page);await page.locator('.tiptap').getByText('A paragraph added by the hosted agent.',{exact:true}).waitFor();
 assert.match(await page.locator('.tiptap').innerText(),/We are writing together/);await page.locator('.tool-activity summary').click();
 await page.locator('.tool-activity').getByText('Read document',{exact:true}).waitFor();await page.locator('.tool-activity').getByText('Added a paragraph',{exact:true}).waitFor();
 await input.fill('/team');await page.getByRole('option',{name:/^\/team/}).waitFor();await input.press('Enter');await input.fill('**Literal user message**');await page.getByRole('button',{name:'Send message',exact:true}).click();
 const literal=page.locator('.message.user').filter({hasText:'**Literal user message**'});await literal.waitFor();assert.equal(await literal.locator('strong').count(),0);assert.equal(await page.locator('.tool-activity').getAttribute('open'),'');
 if(video){await page.getByRole('heading',{name:'Changes',exact:true}).scrollIntoViewIfNeeded();await page.waitForTimeout(1200);await page.screenshot({path:resolve(video,'markdown-top.png')});await page.locator('.message-markdown table').scrollIntoViewIfNeeded();await page.waitForTimeout(1200);await page.screenshot({path:resolve(video,'hosted-agent.png')});}assert.deepEqual(errors,[]);assert.equal(work.length,1);await Promise.all(work);await context.close();
 console.log('PASS: compiled browser /model selection, hosted SDK tool execution, preserved text, Streamdown Markdown, hidden agent IDs, shared transcript and readable tool activity (explicit simulated services).');
}finally{await browser.close();await authority.close();await new Promise<void>(done=>server.close(()=>done()));}
