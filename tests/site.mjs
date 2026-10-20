import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('site'),types={'.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{try{const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname.replace(/\/$/,'/index.html'));if(!path.startsWith(root+'/'))throw new Error('invalid path');res.writeHead(200,{'Content-Type':types[extname(path)]??'application/octet-stream'});res.end(await readFile(path));}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,video=process.env.FORUM_SITE_VIDEO_DIR;
if(video)await mkdir(video,{recursive:true});
const browser=await chromium.launch();
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},...(video?{recordVideo:{dir:video,size:{width:1440,height:1000}}}:{})});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.getByRole('heading',{name:'Multiplayer documents'}).waitFor();
 await page.waitForFunction(()=>document.getElementById('release-status').textContent!=='Checking the latest preview…');
 async function actionsSideBySide(page){
  const open=await page.locator('.hero-actions .button').first().boundingBox(),download=await page.locator('#download-link').boundingBox();
  assert.ok(open&&download&&Math.abs(open.y-download.y)<1&&download.x>=open.x+open.width,'Open and Download must sit next to each other.');
 }
 await actionsSideBySide(page);
 assert.equal(await page.locator('.crew').evaluate(image=>image.complete&&image.naturalWidth>0),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 if(video){await page.screenshot({path:resolve(video,'desktop.png'),fullPage:true});await page.waitForTimeout(1200);await page.getByRole('navigation',{name:'Forum footer'}).scrollIntoViewIfNeeded();await page.waitForTimeout(1200);}
 await context.close();
 const checks=await browser.newContext();const mobile=await checks.newPage();await mobile.setViewportSize({width:375,height:812});await mobile.goto(origin);await actionsSideBySide(mobile);assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(video)await mobile.screenshot({path:resolve(video,'mobile.png'),fullPage:true});
 await mobile.setViewportSize({width:320,height:740});await actionsSideBySide(mobile);
 const preview=await checks.newPage();
 const manifest={product:'forum',platform:'darwin',arch:'arm64',version:'0.1.0',url:'https://downloads.example.test/Forum.zip',sizeBytes:120000000,checksum:'sha256:'+'a'.repeat(64),notarized:true};
 await preview.route('**/release.json',route=>route.fulfill({json:manifest}));await preview.goto(origin);await preview.getByRole('link',{name:'Download Forum',exact:true}).waitFor();
 await preview.route(manifest.url,route=>route.fulfill({headers:{'content-type':'application/zip','content-disposition':'attachment; filename="Forum.zip"'},body:'PK synthetic download fixture'}));
 const download=preview.waitForEvent('download');await preview.getByRole('link',{name:'Download Forum',exact:true}).click();assert.equal((await download).suggestedFilename(),'Forum.zip');
 await preview.unroute('**/release.json');await preview.route('**/release.json',route=>route.fulfill({json:{...manifest,url:'javascript:alert(1)'}}));await preview.reload();await preview.waitForFunction(()=>document.getElementById('release-status').textContent.includes('could not be loaded'));assert.equal(await preview.locator('#download-link').getAttribute('href'),null);
 assert.deepEqual(errors,[]);await checks.close();console.log('PASS: Forum landing page, responsive layout, real image, release states, download interaction and unsafe-URL rejection. Download interaction uses an explicit synthetic release fixture.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
