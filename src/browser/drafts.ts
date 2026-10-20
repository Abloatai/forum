import type {Draft} from '../document/index.js';

/** Web Locks keep separate tabs from replaying the same durable OT client. */
// shortcut: browser quota limits draft size; move persistence to IndexedDB when larger documents require it.
export function browserDrafts(scope:string){
  const prefix=`forum:draft:${scope}:`,owned=new Map<string,{key:string;release:()=>void}>();
  async function claim(key:string){
    if(!navigator.locks)throw new Error('This browser cannot safely recover shared drafts. Use the Mac app.');
    let ready!:(value:(()=>void)|undefined)=>void;
    const result=new Promise<(()=>void)|undefined>(resolve=>{ready=resolve;});
    void navigator.locks.request(key,{ifAvailable:true},lock=>{
      if(!lock){ready(undefined);return;}
      return new Promise<void>(resolve=>{ready(resolve);});
    }).catch(()=>ready(undefined));
    return result;
  }
  function read(key:string):Draft{
    const draft=JSON.parse(localStorage.getItem(key)!);
    if(!draft||typeof draft.id!=='string'||typeof draft.clientID!=='string'||draft.base?.id!==draft.id||!Number.isSafeInteger(draft.base.version)||!Array.isArray(draft.steps))throw new Error('Local draft could not be read. Keep browser data to recover it.');
    return draft;
  }
  return {
    async open(id:string,base:Draft['base']):Promise<Draft>{
      const previous=owned.get(id);if(previous)return read(previous.key);
      const documentPrefix=`${prefix}${id}:`;
      for(const key of Object.keys(localStorage).filter(key=>key.startsWith(documentPrefix))){
        const release=await claim(key);if(!release)continue;
        try{const draft=read(key);if(draft.id!==id)throw new Error('Invalid local draft');owned.set(id,{key,release});return draft;}
        catch(error){release();throw error;}
      }
      const clientID=crypto.randomUUID(),key=documentPrefix+clientID,release=await claim(key);
      if(!release)throw new Error('Could not reserve a local draft');
      owned.set(id,{key,release});
      return {id,clientID,base,steps:[]};
    },
    save(draft:Draft){
      try{
        const owner=owned.get(draft.id);if(!owner||owner.key!==`${prefix}${draft.id}:${draft.clientID}`)throw new Error('Invalid local draft');
        localStorage.setItem(owner.key,JSON.stringify(draft));return {ok:true};
      }catch{return {ok:false,error:'Local save failed. Keep this tab open and free browser storage.'};}
    },
  };
}
