import {randomUUID} from 'node:crypto';
import {EditorState} from '@tiptap/pm/state';
import {Step} from '@tiptap/pm/transform';
import {collab,getVersion,receiveTransaction,sendableSteps} from 'prosemirror-collab';
import {schema,type Snapshot,type Changes,type Request} from '../../src/document/index.js';

export function client(snapshot:Snapshot,id:string){
 let state=EditorState.create({doc:schema.nodeFromJSON(snapshot.doc),plugins:[collab({version:snapshot.version,clientID:id})]});
 return {
  get state(){return state;},
  insert(text:string,at=1){state=state.apply(state.tr.insertText(text,at));},
  bold(from:number,to:number){state=state.apply(state.tr.addMark(from,to,schema.marks.bold.create()));},
  replace(from:number,to:number,text:string){state=state.apply(state.tr.insertText(text,from,to));},
  pending(){return !!sendableSteps(state);},
  request():Request{const pending=sendableSteps(state)!;return {action:'submit',id:snapshot.id,version:pending.version,clientID:pending.clientID,operationId:randomUUID(),steps:pending.steps.map(step=>step.toJSON())};},
  async pull(bridge:{request(input:Request):Promise<unknown>}){
   const changes=await bridge.request({action:'changes',id:snapshot.id,version:getVersion(state)}) as Changes;
   state=state.apply(receiveTransaction(state,changes.steps.map(step=>Step.fromJSON(schema,step)),changes.clientIDs));
  },
 };
}
