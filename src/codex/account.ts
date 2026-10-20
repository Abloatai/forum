// Coding's codex-account flow, with an isolated home and no inherited provider keys.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {safeModels} from '../agent/models.js';
export function codexCommand(){return process.env.FORUM_CODEX_COMMAND??createRequire(join(process.cwd(),'package.json')).resolve('@openai/codex/bin/codex.js');}
export async function openAccount(auth?:string,command=codexCommand()){
 const home=await mkdtemp(join(tmpdir(),'forum-codex-'));if(auth)await writeFile(join(home,'auth.json'),auth,{mode:0o600});
 const child=spawn(command,['-c','cli_auth_credentials_store="file"','-c','forced_login_method="chatgpt"','-c','analytics.enabled=false','app-server'],{cwd:home,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH??'',HOME:home,CODEX_HOME:home,LANG:'en_US.UTF-8'}});
 const lines=createInterface({input:child.stdout});child.stderr.resume();child.stdin.on('error',()=>{});
 let sequence=0,total=0,finished!:(success:boolean)=>void;const completed=new Promise<boolean>(resolve=>finished=resolve);
 const pending=new Map<number,{resolve:(value:any)=>void;reject:()=>void}>();
 const fail=()=>{finished(false);for(const item of pending.values())item.reject();pending.clear();};child.on('error',fail);child.on('exit',fail);
 lines.on('line',line=>{total+=line.length;if(total>2_000_000){fail();child.kill('SIGKILL');return;}try{const message=JSON.parse(line);if(message.method==='account/login/completed')finished(message.params?.success===true);const item=pending.get(message.id);if(item){pending.delete(message.id);if(message.error)item.reject();else item.resolve(message.result);}}catch{fail();}});
 async function request<T=any>(method:string,params:object={}):Promise<T>{let timer:NodeJS.Timeout|undefined;const id=++sequence;try{return await Promise.race([new Promise<T>((resolve,reject)=>{pending.set(id,{resolve,reject:()=>reject(new Error('codex_unavailable'))});child.stdin.write(JSON.stringify({id,method,params})+'\n');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('codex_unavailable')),20000);})]);}finally{clearTimeout(timer);pending.delete(id);}}
 const close=async()=>{fail();child.kill('SIGKILL');lines.close();await rm(home,{recursive:true,force:true});};
 try{await request('initialize',{clientInfo:{name:'forum',title:'Forum',version:'0.1.4'},capabilities:{}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');}catch{await close();throw new Error('codex_unavailable');}
 return {home,request,completed,close,snapshot:()=>readFile(join(home,'auth.json'),'utf8'),async read(refreshToken=false){
  const {account}=await request('account/read',{refreshToken});if(account?.type!=='chatgpt'||typeof account.planType!=='string')throw new Error('codex_connection_required');
  const auth=await readFile(join(home,'auth.json'),'utf8'),tokens=JSON.parse(auth).tokens;
  if(typeof tokens?.access_token!=='string'||!tokens.access_token||typeof tokens.account_id!=='string'||!tokens.account_id)throw new Error('codex_connection_required');
  const models=safeModels(await request('model/list',{limit:100}));
  return {auth,view:{email:typeof account.email==='string'?account.email:'',plan:account.planType,models}};
 }};
}
