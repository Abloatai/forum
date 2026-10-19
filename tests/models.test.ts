import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeModels,discoverModels} from '../src/agent/models.js';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('catalog exposes only allowed safe metadata from initialized backend model/list',async()=>{
  const data={data:[{model:'fixture-model',displayName:'Synthetic fixture model',isDefault:true,access_token:'must-not-leak'},{model:'excluded',displayName:'Other',isDefault:false}]};
  assert.deepEqual(safeModels(data,['fixture-model']),[{id:'fixture-model',name:'Synthetic fixture model',isDefault:true}]);
  const directory=await mkdtemp(join(tmpdir(),'docs-catalog-')),command=join(directory,'catalog.mjs');
  await writeFile(command,`#!/usr/bin/env node\nimport {createInterface} from 'node:readline';let initialized=false,notified=false;createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);if(v.method==='initialized'){notified=true;return;}if(v.method==='initialize'){initialized=true;process.stdout.write(JSON.stringify({id:v.id,result:{}})+'\\n');return;}if(v.method==='model/list'&&initialized&&notified&&v.params.limit===100){process.stdout.write(JSON.stringify({id:v.id,result:${JSON.stringify(data)}})+'\\n');}else process.exit(1);});`);await chmod(command,0o700);
  try{assert.deepEqual(await discoverModels({command,home:directory,allowedModels:['fixture-model']}),safeModels(data,['fixture-model']));}
  finally{await rm(directory,{recursive:true,force:true});}
});
