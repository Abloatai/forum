import {chatPanel} from './chat.js';
import {Editor, Extension} from '@tiptap/core';
import {Step} from '@tiptap/pm/transform';
import {collab, getVersion, receiveTransaction, sendableSteps} from 'prosemirror-collab';
import {createTextEditorExtensions,defaultPaper, type Draft, type Request, type Snapshot, type Changes} from '../document/index.js';
import {createPaginationPlugin,paginationPluginKey} from '../document/pagination.js';

declare global {interface Window {lobbyDocs: {
  browser?:boolean;
  modelAccount?(action:'codex-status'|'codex-connect'|'codex-disconnect'):Promise<{connected:boolean;account?:{email:string;plan:string};login?:{verificationUrl:string;userCode:string;expiresAt:number};error?:string}>;
  authState():Promise<{local:boolean;signedIn:boolean;name:string;pending:boolean;message:string;code:string}>;signIn():Promise<void>;signOut():Promise<void>;
  sendEmailCode?(email:string):Promise<void>;verifyEmailCode?(email:string,code:string):Promise<void>;
  list(): Promise<Snapshot[]>; create(title: string): Promise<Snapshot>; open(id: string): Promise<Draft>;
  request(input: Request): Promise<unknown>; saveDraft(draft: Draft): {ok: boolean; error?: string};
  offline(value: boolean): Promise<boolean>; newWindow(): Promise<void>;
}}}
const api = window.lobbyDocs;
const chat = chatPanel(input => api.request(input), () => api.list());
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let editor: Editor | undefined, draft: Draft | undefined, base: Snapshot | undefined;
let offline = false, syncing = false, opening = false, durable = true;
let syncFinished=Promise.resolve();
const error = (message: string) => {element('error').hidden = !message; element('error').textContent = message;};
const status = (text: string) => {element('status').textContent = text;};
function persist() {
  if (!editor || !draft || !base) return;
  const pending = sendableSteps(editor.state);
  const value: Draft = {...draft, base, steps: pending?.steps.map(step => step.toJSON()) ?? []};
  const result = api.saveDraft(value);
  durable = result.ok;
  if (!result.ok) {error(result.error!); editor.setEditable(false); status('Local save failed'); return;}
  const words = editor.getText().trim().split(/\s+/).filter(Boolean).length;
  element('words').textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
  status(offline ? 'Offline, saved locally' : pending ? 'Saved locally, syncing' : 'Synced');
}
let paperSignature='';
function fitPaper(){
  if(!editor||!base)return;
  const layout=base.layout??'page',paper=base.paper??defaultPaper,canvas=element('canvas'),surface=element('paper');
  const cs=getComputedStyle(canvas),available=Math.max(1,canvas.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight));
  const zoom=layout==='page'?Math.min(1,available/paper.width,Math.max(1,canvas.clientHeight-48)/paper.height):1;
  const signature=JSON.stringify([layout,paper]);
  surface.style.zoom=String(zoom);if(signature===paperSignature)return;paperSignature=signature;
  surface.style.setProperty('--page-height',`${paper.height}px`);surface.style.width=layout==='page'?`${paper.width}px`:'100%';
  surface.style.maxWidth=layout==='page'?'none':'900px';surface.style.minHeight=layout==='page'?`${paper.height}px`:'0';
  surface.style.padding=layout==='page'?`${paper.marginTop}px ${paper.marginRight}px ${paper.marginBottom}px ${paper.marginLeft}px`:`${paper.marginTop}px min(8%, ${paper.marginRight}px) ${paper.marginBottom}px min(8%, ${paper.marginLeft}px)`;
  editor.view.dom.style.minHeight=layout==='page'?`${paper.height-paper.marginTop-paper.marginBottom}px`:'calc(100vh - 260px)';
  editor.unregisterPlugin(paginationPluginKey);
  if(layout==='page')editor.registerPlugin(createPaginationPlugin({pageHeight:paper.height,pageMarginTop:paper.marginTop,pageMarginBottom:paper.marginBottom,pageGap:32,contentWidth:paper.width-paper.marginLeft-paper.marginRight,onPageCountChange:count=>{surface.style.minHeight=`${count*paper.height+(count-1)*32}px`;element('page-count').textContent=`${count} ${count===1?'page':'pages'}`;}}));
}
new ResizeObserver(fitPaper).observe(element('canvas'));
function documentLayout(layout:'page'|'flow'){
  document.body.dataset.layout=layout;
  element<HTMLSelectElement>('document-layout').value=layout;
  paperSignature='';fitPaper();
  element('page-count').hidden=layout==='flow';
}
async function sync() {
  if (!editor || !draft || !base || offline || syncing || opening || !durable) return;
  syncing = true;
  let finish!:()=>void;syncFinished=new Promise<void>(resolve=>{finish=resolve;});
  try {
    const changes = await api.request({action: 'changes', id: draft.id, version: getVersion(editor.state)}) as Changes;
    if(changes.title!==base.title||changes.layout!==(base.layout??'page')||JSON.stringify(changes.paper)!==JSON.stringify(base.paper??defaultPaper)){
      const layoutChanged=changes.layout!==(base.layout??'page')||JSON.stringify(changes.paper)!==JSON.stringify(base.paper??defaultPaper);
      base={...base,title:changes.title,layout:changes.layout,paper:changes.paper};element('title').textContent=base.title;
      if(layoutChanged)documentLayout(changes.layout);
      persist();await library();
    }
    if (changes.steps.length) {
      const steps = changes.steps.map(json => Step.fromJSON(editor!.schema, json));
      let doc = editor.schema.nodeFromJSON(base.doc);
      for (const step of steps) {const result = step.apply(doc); if (!result.doc) throw new Error('Invalid remote history'); doc = result.doc;}
      const transaction = receiveTransaction(editor.state, steps, changes.clientIDs, {mapSelectionBackward: true});
      base = {...base, doc: doc.toJSON(), version: changes.version};
      editor.view.dispatch(transaction);
      persist();
    }
    const pending = sendableSteps(editor.state);
    if (pending) {
      // Persist BEFORE sending. A dropped response is recovered by pulling our
      // own accepted steps with the same durable clientID, never blind replay.
      persist(); if (!durable) return;
      await api.request({action: 'submit', id: draft.id, version: pending.version, operationId: crypto.randomUUID(), steps: pending.steps.slice(0,256).map(s => s.toJSON())});
    } else {status('Synced');}
  } catch (cause) {status('Disconnected, saved locally'); element('status').title = String(cause);}
  finally {syncing = false;finish();}
}
async function library() {
  const documents = await api.list();
  const root = element('library'),grid=element('document-grid'); root.replaceChildren();grid.replaceChildren();
  element('empty-library').hidden=documents.length>0;
  const seen = new Set<string>();
  for (const doc of documents) {
    if (seen.has(doc.id)) continue; seen.add(doc.id);
    const button = document.createElement('button'); button.textContent = doc.title;button.dataset.documentId=doc.id; button.setAttribute('aria-current', String(doc.id === draft?.id));
    button.onclick = () => void openDocument(doc.id).catch(e => error(e.message)); root.append(button);
    const card=document.createElement('button');card.className='document-card';card.dataset.documentId=doc.id;card.setAttribute('aria-label',`Open ${doc.title}`);
    const preview=document.createElement('span');preview.className='document-preview';preview.setAttribute('aria-hidden','true');
    const icon=element('new-document').querySelector('svg')!.cloneNode(true) as SVGElement;icon.querySelector('path:last-child')?.setAttribute('d','M14 2v6h6');preview.append(icon);
    const title=document.createElement('span');title.textContent=doc.title;card.append(preview,title);card.onclick=button.onclick;grid.append(card);
  }
}
async function prepareNavigation(){
  if(opening)return false;
  opening=true;await syncFinished;
  persist();if(!durable){opening=false;return false;}
  editor?.setEditable(false);error('');return true;
}
async function openDocument(id: string) {
  if(!await prepareNavigation())return;
  try {
    const loaded = await api.open(id);
    editor?.destroy(); draft = loaded; base = loaded.base; durable = true;
    document.body.classList.remove('overview');
    element('welcome').hidden = true; element('paper').hidden = false; element('toolbar').hidden = false;
    element('title').textContent = base.title; chat.open(id); error('');
    editor = new Editor({element: element('editor'), extensions: [
      ...createTextEditorExtensions(),
      Extension.create({name: 'lobbyOT', addProseMirrorPlugins: () => [collab({version: loaded.base.version, clientID: loaded.clientID})]}),
    ], content: base.doc, editorProps: {attributes: {'aria-label': 'Document content', role: 'textbox', 'aria-multiline': 'true'}}});
    documentLayout(base.layout??'page');
    // Restore the confirmed base, then replay unsent operations into collab state.
    if (loaded.steps.length) {
      let tr = editor.state.tr;
      for (const json of loaded.steps) tr = tr.step(Step.fromJSON(editor.schema,json));
      editor.view.dispatch(tr.setMeta('addToHistory',false));
    }
    editor.on('transaction', ({transaction}) => {if (transaction.docChanged) persist();});
    editor.on('selectionUpdate', updateToolbar);
    persist(); updateToolbar(); await library();
  } finally {opening = false;editor?.setEditable(durable);}
  void sync();
}
const commands: Record<string, () => void> = {
  bold: () => {editor?.chain().focus().toggleBold().run();}, italic: () => {editor?.chain().focus().toggleItalic().run();},
  underline: () => {editor?.chain().focus().toggleUnderline().run();}, strike: () => {editor?.chain().focus().toggleStrike().run();},
  paragraph: () => {editor?.chain().focus().setParagraph().run();}, heading: () => {editor?.chain().focus().toggleHeading({level:2}).run();},
  bullet: () => {editor?.chain().focus().toggleBulletList().run();}, ordered: () => {editor?.chain().focus().toggleOrderedList().run();},
  quote: () => {editor?.chain().focus().toggleBlockquote().run();}, code: () => {editor?.chain().focus().toggleCodeBlock().run();},
  undo: () => {editor?.chain().focus().undo().run();}, redo: () => {editor?.chain().focus().redo().run();},
};
function updateToolbar() {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
    const name = button.dataset.command!;
    const node = ({bullet:'bulletList',ordered:'orderedList',quote:'blockquote',code:'codeBlock'} as Record<string,string>)[name] ?? name;
    button.setAttribute('aria-pressed', String(editor?.isActive(node) ?? false));
  }
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
  button.onmousedown = event => event.preventDefault();
  button.onclick = () => {if(opening)return;commands[button.dataset.command!]?.(); updateToolbar();};
}
element('new-document').onclick=async()=>{
  if(!await prepareNavigation())return;
  const button=element<HTMLButtonElement>('new-document');button.disabled=true;
  void api.create('Untitled').then(doc=>{opening=false;return openDocument(doc.id);}).catch(e=>error(e.message)).finally(()=>{opening=false;button.disabled=false;editor?.setEditable(durable);});
};
async function showDocuments(){
  if(!await prepareNavigation())return;
  editor?.destroy();editor=undefined;draft=undefined;base=undefined;chat.close();
  document.body.classList.add('overview');element('welcome').hidden=false;element('paper').hidden=true;element('toolbar').hidden=true;element('title').textContent='Documents';error('');
  opening=false;void library().catch(e=>error(e.message));
}
element('home').onclick=showDocuments;element('documents-home').onclick=showDocuments;
element('toggle-sidebar').onclick=()=>{const sidebar=element('document-sidebar');sidebar.hidden=!sidebar.hidden;element('toggle-sidebar').setAttribute('aria-expanded',String(!sidebar.hidden));};
element('document-layout').onchange=()=>{
  if(!draft||!base)return;
  const select=element<HTMLSelectElement>('document-layout'),id=draft.id;select.disabled=true;
  void api.request({action:'layout',id,layout:select.value}).then(()=>sync()).catch(e=>{select.value=base?.layout??'page';error(e.message);}).finally(()=>{select.disabled=false;});
};
let emailSent=false,emailAddress='',emailBusy=false;
async function authView(){
  const auth=await api.authState(),required=!auth.local&&!auth.signedIn;
  element('sign-in').hidden=!required;
  document.body.classList.toggle('signed-out',required);
  element('sign-in-title').textContent=emailSent?'Check your inbox':'Welcome to Forum';
  element('sign-in-button').textContent=auth.pending?'Cancel':api.browser?'Sign in':'Continue with Google';
  element('sign-in-button').hidden=emailSent;
  element('email-sign-in').hidden=!!api.browser||auth.pending&&!emailBusy;
  element('email-form').hidden=emailSent;element('code-form').hidden=!emailSent;
  element('sign-in-status').textContent=[auth.message,auth.code].filter(Boolean).join(' ');
  element('codex-account').hidden=auth.local||!api.modelAccount;
  element('account').hidden=auth.local||required;
  element('account').textContent=auth.name.trim().slice(0,1).toUpperCase();element('account-name').textContent=auth.name;
  return !required;
}
element('email-form').onsubmit=event=>{
  event.preventDefault();if(emailBusy)return;emailBusy=true;const button=element('email-form').querySelector('button')!;button.disabled=true;
  emailAddress=element<HTMLInputElement>('sign-in-email').value.trim();
  void api.sendEmailCode?.(emailAddress).then(()=>{emailSent=true;}).catch(()=>{}).finally(()=>{emailBusy=false;button.disabled=false;void authView();element<HTMLInputElement>('sign-in-code').focus();});
};
element('code-form').onsubmit=event=>{
  event.preventDefault();if(emailBusy)return;emailBusy=true;const button=element('code-form').querySelector('button')!;button.disabled=true;
  void api.verifyEmailCode?.(emailAddress,element<HTMLInputElement>('sign-in-code').value).catch(()=>{}).finally(()=>{emailBusy=false;button.disabled=false;void authView();});
};
element('change-email').onclick=()=>{emailSent=false;void authView();};
element('sign-in-button').onclick=()=>{void api.authState().then(auth=>auth.pending?api.signOut():api.signIn()).then(authView);};
element('account').onclick=()=>{const menu=element('account-menu');menu.hidden=!menu.hidden;element('account').setAttribute('aria-expanded',String(!menu.hidden));};
element('sign-out').onclick=()=>{persist();void api.signOut();};
void authView().then(ready=>{if(ready)return library();}).catch(e=>error(e.message)).finally(()=>document.body.classList.remove('booting'));
setInterval(()=>void authView(),1000);
setInterval(() => void sync(), 250);

let codexBusy=false;
async function codexView(action:'codex-status'|'codex-connect'|'codex-disconnect'='codex-status'){
 if(codexBusy||!api.modelAccount)return;codexBusy=true;
 const connect=element<HTMLButtonElement>('codex-connect');connect.disabled=true;
 try{const state=await api.modelAccount(action);
  element('codex-description').textContent=state.connected?`Connected as ${state.account?.email??'your account'}. Uses your ChatGPT plan.`:'Connect your own ChatGPT account to use agents. Your plan covers your requests.';
  element('codex-status').textContent=state.error??(state.login?'Approve the sign-in in your browser.':'');
  element('codex-code').textContent=state.login?.userCode??'';
  const link=element<HTMLAnchorElement>('codex-link');link.hidden=!state.login;link.href=state.login?.verificationUrl==='https://auth.openai.com/codex/device'?state.login.verificationUrl:'https://auth.openai.com/codex/device';
  connect.hidden=state.connected||!!state.login;element('codex-disconnect').hidden=!state.connected&&!state.login;
 }catch{element('codex-status').textContent='Codex connection is unavailable. Try again shortly.';}
 finally{codexBusy=false;connect.disabled=false;}
}
element('codex-account').onclick=()=>{element<HTMLDialogElement>('codex-dialog').showModal();void codexView();};
element('codex-close').onclick=()=>element<HTMLDialogElement>('codex-dialog').close();
element('codex-connect').onclick=()=>{void codexView('codex-connect');};
element('codex-disconnect').onclick=()=>{void codexView('codex-disconnect');};
setInterval(()=>{if(element<HTMLDialogElement>('codex-dialog').open)void codexView();},2000);

element('paper').addEventListener('mousedown',event=>{
 if(event.button!==0||!editor||!(event.target===element('paper')||event.target===element('editor')))return;
 event.preventDefault();const point=editor.view.posAtCoords({left:event.clientX,top:event.clientY});editor.commands.focus(point?.pos??'end');
});
