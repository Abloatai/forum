import {readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import type {Identity} from './authority.js';
export type Vault={isEncryptionAvailable():boolean;getSelectedStorageBackend?():string;encryptString(text:string):Buffer;decryptString(bytes:Buffer):string};
export type Session={token:string;identity:Identity};
export function sessionStorage(directory:string,binding:string,vault:Vault){
  const path=join(directory,'auth-session.bin');
  const available=()=>vault.isEncryptionAvailable()&&vault.getSelectedStorageBackend?.()!=='basic_text';
  return {
    available,
    load():Session|undefined{
      if(!available())return;
      try{
        const value=JSON.parse(vault.decryptString(readFileSync(path)));
        if(value.binding!==binding||typeof value.token!=='string'||!value.token||value.token.length>4096||typeof value.identity?.userId!=='string'||typeof value.identity?.organizationId!=='string'||typeof value.identity?.name!=='string'||typeof value.identity?.workspace!=='string')return;
        return {token:value.token,identity:{userId:value.identity.userId,organizationId:value.identity.organizationId,name:value.identity.name,workspace:value.identity.workspace}};
      }catch{return;}
    },
    save(session:Session){
      if(!available())return false;
      const {userId,organizationId,name,workspace}=session.identity;
      try{const bytes=vault.encryptString(JSON.stringify({binding,token:session.token,identity:{userId,organizationId,name,workspace}}));
      writeFileSync(path+'.tmp',bytes,{mode:0o600});renameSync(path+'.tmp',path);return true;}catch{return false;}
    },
    clear(){rmSync(path,{force:true});rmSync(path+'.tmp',{force:true});},
  };
}
