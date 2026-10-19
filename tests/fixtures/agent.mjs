#!/usr/bin/env node
// Explicit deterministic test process. No model, network provider, or credentials.
import assert from 'node:assert/strict';
assert.equal(process.env.ABLO_API_KEY,undefined);
const url=process.env.LOBBY_DOCS_TEST_MCP;
if(!url)throw new Error('This fixture requires explicit scripted mode');
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
let sequence=0;
async function rpc(method,params={},auth=process.env.DOCUMENT_MCP_TOKEN){const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params})});return response;}
assert.equal((await rpc('tools/list',{},'wrong')).status,403);
const init=await(await rpc('initialize',{protocolVersion:'2024-11-05'})).json();assert.equal(init.result.serverInfo.name,'lobby-docs');
const tools=await(await rpc('tools/list')).json();assert.equal(tools.result.tools.length,5);
async function call(name,args={}){return (await(await rpc('tools/call',{name,arguments:args})).json()).result;}
const read=async()=>JSON.parse((await call('read_document')).content[0].text);
let doc=await read();
if(prompt.includes('wait for stop'))await new Promise(resolve=>setTimeout(resolve,60_000));
else if(prompt.includes('append alpha')||prompt.includes('append beta')){
  const text=prompt.includes('append alpha')?'Agent alpha addition.':'Agent beta addition.';
  await new Promise(resolve=>setTimeout(resolve,2000));
  for(let attempt=0;attempt<5;attempt++){const result=await call('append_paragraph',{version:doc.version,text});if(!result.isError)break;if(attempt===4)throw new Error(result.content[0].text);doc=await read();}
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:`Scripted test: appended ${text} through the document tool. No live model was used.`}}));
  console.log(JSON.stringify({type:'turn.completed'}));process.exit(0);
}
else {
  await new Promise(resolve=>setTimeout(resolve,prompt.includes('revocation check')?6000:1200));
  let result=await call('replace_text',{version:doc.version,find:'A small document.',text:'A focused document.'});
  if(result.isError){doc=await read();result=await call('replace_text',{version:doc.version,find:'A small document.',text:'A focused document.'});}
  if(result.isError)throw new Error(result.content[0].text);
  doc=await read();
  if(doc.title==='Untitled'){const configured=await call('configure_paper',{version:doc.version,expectedPaper:doc.paper,paper:{...doc.paper,width:816,height:1056,marginTop:72,marginRight:72,marginBottom:72,marginLeft:72}});if(configured.isError)throw new Error(configured.content[0].text);const named=await call('rename_document',{version:doc.version,expectedTitle:doc.title,title:'A shared place to think'});if(named.isError)throw new Error(named.content[0].text);}
}
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Scripted test: changed “A small document” to “A focused document” through the document tool. No live model was used.'}}));
console.log(JSON.stringify({type:'turn.completed'}));
