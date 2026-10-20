// Actual compiled handoff page; Google/Auth responses are explicit fixtures.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const server=createServer(async(req,res)=>{
  const path=new URL(req.url!,'http://localhost').pathname;
  const file=path==='/signin/desktop/'?'dist/desktop/index.html':path==='/signin/desktop/index.js'?'dist/desktop/index.js':path==='/app/style.css'?'dist/browser/style.css':undefined;
  if(!file){res.writeHead(404).end();return;}
  res.setHeader('content-type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'application/javascript':'text/css');res.end(await readFile(file));
});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`,query=new URLSearchParams({client_id:'electron',state:'s'.repeat(22),code_challenge:'c'.repeat(43),code_challenge_method:'S256'});
const browser=await chromium.launch();let requests=0;
try{
  const context=await browser.newContext();
  await context.route('https://auth.abloatai.com/**',async route=>{
    const request=route.request(),headers={'access-control-allow-origin':origin,'access-control-allow-credentials':'true','access-control-allow-methods':'POST','access-control-allow-headers':'content-type'};
    if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
    requests++;const url=new URL(request.url());assert.equal(url.pathname,'/api/auth/sign-in/social');
    assert.equal(url.searchParams.get('state'),query.get('state'));assert.equal(url.searchParams.get('code_challenge'),query.get('code_challenge'));
    const body=request.postDataJSON();assert.equal(body.provider,'google');assert.equal(body.callbackURL,origin+'/signin/desktop/?'+query);
    await route.fulfill({headers,json:{url:'https://accounts.google.com/fixture-consent',redirect:true}});
  });
  await context.route('https://accounts.google.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>Sample Google consent — intercepted response</h1>'}));
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',entry=>{if(entry.type()==='error')errors.push(entry.text());});
  await page.goto(origin+'/signin/desktop/?'+query);
  await page.getByRole('heading',{name:'Sample Google consent — intercepted response'}).waitFor({timeout:5000});assert.equal(requests,1);
  await page.goto(origin+'/signin/desktop/');await page.getByRole('status').getByText('Open sign-in from Forum to try again.',{exact:true}).waitFor();assert.equal(requests,1);
  const code=Buffer.from(JSON.stringify({state:query.get('state'),identifier:'a'.repeat(32)})).toString('base64url');
  await context.addCookies([{name:'better-auth.electron',value:code,url:origin,httpOnly:false}]);
  // Suppress the native redirect timer so this browser-only test cannot launch a real app.
  await page.addInitScript(()=>{window.setInterval=(()=>0) as typeof window.setInterval;});
  await page.goto(origin+'/signin/desktop/?'+query);const link=page.getByRole('link',{name:'Open Forum',exact:true});await link.waitFor();
  assert.equal(await link.getAttribute('href'),'com.ablo.forum://auth/callback#token='+code);assert.equal(requests,1);
  assert.deepEqual(errors,[]);await context.close();console.log('PASS: compiled desktop page initiates Google once with the native PKCE query, rejects invalid links, and produces the matching Forum callback (intercepted provider responses; native redirect timer suppressed).');
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
