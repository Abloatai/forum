import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {schema,type Snapshot} from '../../src/document/index.js';
import {BridgeError,type connectBridge} from '../../src/realtime/index.js';
import {client} from './editor.js';

export async function concurrentEditors(bridges:ReturnType<typeof connectBridge>[],rounds:number){
 const id=randomUUID(),started=Date.now(),initial=await bridges[0].request({action:'create',id,title:'Synthetic concurrency check'}) as Snapshot;
 const writers=bridges.map((_,i)=>client(initial,'writer-'+i)),markers:string[]=[];let conflicts=0,disconnects=0,recoveries=0;
 await Promise.all(writers.map(async(writer,index)=>{
  for(let round=0;round<rounds;round++){
   const marker=`[${index}:${round}]`;markers.push(marker);writer.insert(marker);
   if(round%3===0){bridges[index].disconnect();disconnects++;}
   for(let attempt=0;writer.pending();attempt++){
    assert.ok(attempt<200&&Date.now()-started<180_000,'A writer failed to make progress within the test budget.');
    try{
     await writer.pull(bridges[index]);
     if(writer.pending()){const result=await bridges[index].request(writer.request()) as {accepted:boolean};if(!result.accepted)conflicts++;}
    }catch(error){
     if(!(error instanceof BridgeError)||!['outcome_unknown','adapter_unavailable','adapter_busy'].includes(error.code))throw error;
     recoveries++;await new Promise(done=>setTimeout(done,250));
     // Pull first on retry; a timed-out submit may already be in confirmed history.
    }
   }
  }
 }));
 await Promise.all(writers.map((writer,i)=>writer.pull(bridges[i])));
 const final=await bridges[0].request({action:'open',id}) as Snapshot;
 for(const writer of writers){assert.equal(writer.pending(),false);assert.deepEqual(writer.state.doc.toJSON(),final.doc);}
 const text=schema.nodeFromJSON(final.doc).textContent;
 for(const marker of markers)assert.equal(text.split(marker).length-1,1,marker);
 assert.equal(final.version,markers.length);
 return {documentId:id,clients:bridges.length,edits:markers.length,version:final.version,conflicts,disconnects,recoveries,converged:true,durationMs:Date.now()-started,doc:final.doc};
}
