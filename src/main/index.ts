import {app, BrowserWindow, ipcMain, session, dialog, safeStorage, shell} from 'electron';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomBytes, randomUUID} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {nativeSignIn,sessionStorage,type Session,workspaceClient,secureOrigin} from '../auth/index.js';
import {startServer} from '../server/index.js';
import {connectBridge} from '../realtime/index.js';
import {identifier, schema, type Draft, type Request, type Snapshot} from '../document/index.js';
import {Step} from '@tiptap/pm/transform';

app.setName('Forum');
if (process.env.LOBBY_DOCS_PROFILE) app.setPath('userData', process.env.LOBBY_DOCS_PROFILE);
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
const html = join(__dirname, '../renderer/index.html'), trustedURL = pathToFileURL(html).href;
const windows = new Map<number, {window: BrowserWindow; bridge: ReturnType<typeof connectBridge>; draft?: Draft; offline: boolean}>();
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let drafts: DatabaseSync|undefined;
const local=!!process.env.ABLO_API_KEY;
const site=secureOrigin(process.env.FORUM_API_URL??'https://forum.abloatai.com');
let signedIn:Session|undefined,saved:ReturnType<typeof sessionStorage>|undefined,login:AbortController|undefined,authMessage='',generation=0;
const native=nativeSignIn(site,(...args)=>fetch(...args));
const remote=workspaceClient(site,()=>signedIn?.token,()=>resetIdentity(),fetch,()=>signedIn?.identity.organizationId);
function resetIdentity(value?:Session){
  generation++;login?.abort();login=undefined;native.cancel();signedIn=value;
  for(const state of windows.values()){state.bridge.close();state.draft=undefined;}
  drafts?.close();drafts=undefined;
  if(value){saved?.save(value);openDrafts(`${site}:${value.identity.organizationId}:${value.identity.userId}`);}else saved?.clear();
  for(const state of windows.values()){state.bridge=workspaceBridge();state.window.webContents.reload();}
}
async function acceptSession(token:string,controller:AbortController){
  if(controller.signal.aborted)return;
  const verified=await workspaceClient(site,()=>token,()=>{})({action:'session'});
  if(controller.signal.aborted)return;
  authMessage='';resetIdentity({token,identity:verified.identity});
}
async function googleCallback(url:string){
  const controller=login;if(!controller)return;
  try{await acceptSession(await native.completeGoogle(url),controller);}
  catch{if(login===controller)authMessage='Sign-in did not finish. Cancel and try again.';}
  windows.values().next().value?.window.focus();
}
app.on('open-url',(event,url)=>{event.preventDefault();void googleCallback(url);});
function workspaceBridge(){
  if(local)return connectBridge(endpoint,token);
  const epoch=generation;let closed=false;
  return {async request(input:Request){if(closed||epoch!==generation)throw new Error('identity_changed');const value=await remote(input);if(closed||epoch!==generation)throw new Error('identity_changed');return value.result;},disconnect(){},close(){closed=true;}};
}
function openDrafts(scope:string){
  const draftFile=join(app.getPath('userData'),`drafts-${createHash('sha256').update(scope).digest('hex').slice(0,24)}.sqlite`);
  drafts=new DatabaseSync(draftFile);chmodSync(draftFile,0o600);
  drafts.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS drafts(client TEXT PRIMARY KEY, document TEXT NOT NULL, value TEXT NOT NULL)');
}
let endpoint: string, token: string;
function sender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  const state = windows.get(event.sender.id);
  if (!state || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== trustedURL) throw new Error('Untrusted IPC sender');
  return state;
}
function newWindow() {
  // Security settings and separate bundled preload follow Coding desktop.
  const window = new BrowserWindow({width: 1280, height: 900, minWidth: 850, minHeight: 600, backgroundColor: '#fafafa',
    webPreferences: {preload: join(__dirname, '../preload/index.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true}});
  const state = {window, bridge: workspaceBridge(), offline: false};
  const windowId = window.webContents.id;
  windows.set(windowId, state);
  window.webContents.setWindowOpenHandler(({url}) => {
    try{const target=new URL(url);if(['http:','https:'].includes(target.protocol)&&!target.username&&!target.password)void shell.openExternal(target.href).catch(()=>{});}catch{/* Invalid links stay inside the denied popup. */}
    return {action:'deny'};
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('closed', () => {state.bridge.close(); windows.delete(windowId);});
  void window.loadFile(html);
}
if (locked) void app.whenReady().then(async () => {
  const directory = app.getPath('userData'); mkdirSync(directory, {recursive: true, mode: 0o700});
  if(local){
    token=randomBytes(32).toString('hex');server=await startServer({token});endpoint=server.url;openDrafts(server.workspace);
  }else{
    if(process.defaultApp&&process.argv[1])app.setAsDefaultProtocolClient('com.ablo.forum',process.execPath,[process.argv[1]]);
    else app.setAsDefaultProtocolClient('com.ablo.forum');
    endpoint=site;
    saved=sessionStorage(directory,site,safeStorage);
    const previous=saved.load();
    if(previous){
      signedIn=previous;
      try{const result=await remote({action:'session'});resetIdentity({token:previous.token,identity:result.identity});}
      catch{signedIn=undefined;authMessage='Sign in to reconnect to your workspace.';}
    }
  }
  ipcMain.handle('docs:auth-state',event=>{sender(event);return {local,signedIn:!!signedIn,name:signedIn?.identity.name??'',pending:!!login,message:authMessage,code:''};});
  ipcMain.handle('docs:sign-in',event=>{
    sender(event);if(local||login)return;
    const controller=new AbortController();login=controller;authMessage='Continue with Google in your browser.';
    const expiry=setTimeout(()=>{if(login===controller){login=undefined;native.cancel();authMessage='Sign-in expired. Try again.';}},300000);expiry.unref();
    controller.signal.addEventListener('abort',()=>clearTimeout(expiry),{once:true});
    void shell.openExternal(native.beginGoogle()).catch(()=>{if(login===controller){controller.abort();login=undefined;native.cancel();authMessage='The browser could not open. Try again.';}});
  });
  ipcMain.handle('docs:send-email-code',async(event,email:string)=>{
    sender(event);if(local||login)throw new Error('Sign-in already in progress');
    const controller=new AbortController();login=controller;authMessage='';
    try{await native.sendEmailCode(email);if(controller.signal.aborted)throw new Error('Sign-in cancelled');}
    catch{authMessage='Could not send the code. Check the address and try again.';throw new Error(authMessage);}
    finally{if(login===controller)login=undefined;}
  });
  ipcMain.handle('docs:verify-email-code',async(event,email:string,code:string)=>{
    sender(event);if(local||login)throw new Error('Sign-in already in progress');
    const controller=new AbortController();login=controller;authMessage='';
    try{await acceptSession(await native.verifyEmailCode(email,code),controller);}
    catch{authMessage='Invalid or expired code. Try again.';throw new Error(authMessage);}
    finally{if(login===controller)login=undefined;}
  });
  ipcMain.handle('docs:sign-out',event=>{
    sender(event);if(local)return;const previous=signedIn?.token;authMessage='';resetIdentity();
    if(previous)void fetch('https://auth.abloatai.com/api/auth/sign-out',{method:'POST',headers:{origin:'https://www.abloatai.com',authorization:`Bearer ${previous}`,'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(5000)}).catch(()=>{});
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  ipcMain.handle('docs:list', async event => {
    const state = sender(event);
    try {return await state.bridge.request({action: 'list'});} catch {
      return drafts?.prepare('SELECT value FROM drafts').all().map(row => JSON.parse(row.value as string).base)??[];
    }
  });
  ipcMain.handle('docs:create', async (event, title: unknown) => {
    const state = sender(event); if (state.offline) throw new Error('Reconnect to create a document');
    return state.bridge.request({action: 'create', id: randomUUID(), title});
  });
  ipcMain.handle('docs:open', async (event, id: unknown) => {
    const state = sender(event); identifier(id);if(!drafts)throw new Error('auth_required');
    const busy = new Set([...windows.values()].filter(w => w !== state).map(w => w.draft?.clientID));
    const recovery = drafts.prepare('SELECT client,value FROM drafts WHERE document=?').all(id).find(row => !busy.has(row.client as string));
    const draft: Draft = recovery ? JSON.parse(recovery.value as string) : {id, clientID: randomUUID(), base: await state.bridge.request({action: 'open', id}) as Snapshot, steps: []};
    state.draft = draft;
    return draft;
  });
  ipcMain.handle('docs:model-account',async(event,action:unknown)=>{const state=sender(event);if(!['codex-status','codex-connect','codex-disconnect'].includes(String(action)))throw new Error('Invalid account request');const response=await state.bridge.request({action:String(action)});return response;});
  ipcMain.handle('docs:request', async (event, input: Request) => {
    const state = sender(event);
    if (state.offline) throw new Error('Offline');
    if (!state.draft || !input || !['changes','submit','layout','chat-state','chat-send','chat-stop'].includes(input.action) || input.id !== state.draft.id) throw new Error('Invalid document request');
    return state.bridge.request({...input, clientID: state.draft.clientID});
  });
  // Synchronous local durability: no network on this channel, and no acknowledged
  // "saved locally" UI until SQLite has committed the draft and pending OT steps.
  ipcMain.on('docs:save-draft', (event, value: Draft) => {
    try {
      const state = sender(event);
      if (!drafts || !state.draft || value.id !== state.draft.id || value.clientID !== state.draft.clientID || JSON.stringify(value).length > 4_000_000) throw new Error('Invalid draft');
      if (value.base.id !== value.id || !Number.isSafeInteger(value.base.version) || value.base.version < 0 || !Array.isArray(value.steps)) throw new Error('Invalid draft');
      let doc = schema.nodeFromJSON(value.base.doc); doc.check();
      for (const step of value.steps) {const result = Step.fromJSON(schema, step).apply(doc); if (!result.doc) throw new Error('Invalid draft step'); doc = result.doc; doc.check();}
      drafts.prepare('INSERT OR REPLACE INTO drafts VALUES(?,?,?)').run(value.clientID, value.id, JSON.stringify(value));
      state.draft = value; event.returnValue = {ok: true};
    } catch {event.returnValue = {ok: false, error: 'Local save failed. Keep this window open.'};}
  });
  ipcMain.handle('docs:offline', (event, value: unknown) => {const state = sender(event); if (typeof value !== 'boolean') throw new Error('Invalid mode'); state.offline = value; if (value) state.bridge.disconnect(); return value;});
  ipcMain.handle('docs:new-window', event => {sender(event); newWindow();});
  newWindow();
}).catch(()=>{dialog.showErrorBox('Forum could not start','Please reopen Forum. Your local drafts have been kept.');app.quit();});
app.on('second-instance', (_event,argv) => {
  const callback=argv.find(value=>value.startsWith('com.ablo.forum:'));
  if(callback){void googleCallback(callback);return;}
  if (endpoint) newWindow();
});
app.on('activate', () => {if (endpoint && windows.size === 0) newWindow();});
app.on('window-all-closed', () => app.quit());
let quitting = false;
app.on('before-quit', event => {
  login?.abort();
  if (quitting || !endpoint) return;
  event.preventDefault(); quitting = true;
  for (const value of windows.values()) value.bridge.close();
  void (server?.close() ?? Promise.resolve()).finally(() => {drafts?.close(); app.quit();});
});
