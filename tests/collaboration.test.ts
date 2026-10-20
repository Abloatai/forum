import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {getVersion, sendableSteps} from 'prosemirror-collab';
import {schema, type Snapshot} from '../src/document/index.js';
import {startServer, openAuthority} from './fixtures/authority.js';
import {connectBridge} from '../src/realtime/index.js';
import {client} from './fixtures/editor.js';

const token = 'synthetic-test-token-'.repeat(3);
test('real Lobby bridge: concurrent same-paragraph OT, formatting, disconnect, lost response, restart',async()=>{
 const documentID=randomUUID();
  const directory = await mkdtemp(join(tmpdir(),'lobby-docs-test-')), database = join(directory,'docs.sqlite');
  let server = await startServer({database,token});
  let aBridge = connectBridge(server.url,token), bBridge = connectBridge(server.url,token);
  try {
    const initial = await aBridge.request({action:'create',id:documentID,title:'Synthetic test'}) as Snapshot;
    const a = client(initial,'a'), b = client(initial,'b');
    a.insert('Alpha '); b.insert('Beta ');
    const results = await Promise.all([aBridge.request(a.request()), bBridge.request(b.request())]) as {accepted:boolean}[];
    assert.equal(results.filter(r=>r.accepted).length,1);
    await a.pull(aBridge); await b.pull(bBridge);
    if (sendableSteps(a.state)) await aBridge.request(a.request());
    if (sendableSteps(b.state)) await bBridge.request(b.request());
    await a.pull(aBridge); await b.pull(bBridge);
    assert.deepEqual(a.state.doc.toJSON(),b.state.doc.toJSON());
    assert.match(a.state.doc.textContent,/Alpha/); assert.match(a.state.doc.textContent,/Beta/);
    bBridge.disconnect(); b.insert('Offline ',2);
    a.bold(1,6); await aBridge.request(a.request()); await a.pull(aBridge);
    await b.pull(bBridge); const lost = b.request();
    // Server commit succeeds; ignore its response to model response loss.
    await bBridge.request(lost); bBridge.disconnect();
    await b.pull(bBridge); assert.equal(sendableSteps(b.state),null);
    await a.pull(aBridge); assert.deepEqual(a.state.doc.toJSON(),b.state.doc.toJSON());
    assert.match(a.state.doc.textContent,/Offline/);
    assert.ok(JSON.stringify(a.state.doc.toJSON()).includes('bold'));
    const expected = a.state.doc.toJSON();
    aBridge.close(); bBridge.close(); await server.close();
    server = await startServer({database,token}); aBridge = connectBridge(server.url,token); bBridge = connectBridge(server.url,token);
    const reopened = await aBridge.request({action:'open',id:documentID}) as Snapshot;
    assert.deepEqual(reopened.doc,expected); assert.equal(reopened.version,getVersion(a.state));
    const replay = await aBridge.request(lost) as {accepted:boolean}; assert.equal(replay.accepted,true);
    const after = await aBridge.request({action:'open',id:documentID}) as Snapshot; assert.equal(after.version,reopened.version);
  } finally {aBridge.close();bBridge.close();await server.close();await rm(directory,{recursive:true,force:true});}
});
test('unauthorized bridge and insecure remote connections are rejected',async()=>{
 const documentID=randomUUID();
  const directory = await mkdtemp(join(tmpdir(),'lobby-docs-auth-'));
  const server = await startServer({database:join(directory,'docs.sqlite'),token});
  const denied = connectBridge(server.url,'wrong');
  try {await assert.rejects(denied.request({action:'list'})); assert.throws(()=>connectBridge('ws://example.com',token),/requires wss/);}
  finally {denied.close(); await server.close();await rm(directory,{recursive:true,force:true});}
});
test('invalid batches are atomic and operation identities cannot change payload',async()=>{
 const documentID=randomUUID();
  const directory = await mkdtemp(join(tmpdir(),'lobby-docs-atomic-'));
  const authority = openAuthority(join(directory,'docs.sqlite'));
  try {
    const snapshot = await authority.request({action:'create',id:documentID,title:'Atomic'}) as Snapshot;
    const a = client(snapshot,'a'); a.insert('Safe'); const request = a.request();
    await assert.rejects(()=>authority.request({...request,steps:[...(request.steps as unknown[]),{stepType:'replace',from:999,to:999}]}));
    assert.equal((await authority.request({action:'open',id:documentID}) as Snapshot).version,0);
    await authority.request(request);
    await assert.rejects(()=>authority.request({...request,clientID:'another'}),/operation_id_reused/);
    await assert.rejects(()=>authority.request({action:'changes',id:documentID,version:-1}),/invalid_version/);
  } finally {await authority.close();await rm(directory,{recursive:true,force:true});}
});
