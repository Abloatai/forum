import {composerMenu} from './composer.js';
import type {Request} from '../document/index.js';
type State={messages:{id:string;author:string;kind:string;text:string}[];run:{status:string}|null;activeRuns:number;members:string[];agent:string|null};
export function chatPanel(request:(input:Request)=>Promise<unknown>, listDocuments:()=>Promise<{id:string;title:string}[]>) {
  const get=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
  let documentID:string|undefined,busy=false,last='',messageID=crypto.randomUUID(),pendingText='',pendingAgent=false;
  const text=get<HTMLTextAreaElement>('chat-input'),send=get<HTMLButtonElement>('chat-send'),stop=get<HTMLButtonElement>('chat-stop');
  const menu=composerMenu(text,get('composer-menu'),listDocuments,message=>{get('chat-status').textContent=message;});
  async function refresh(){
    if(!documentID||busy)return;busy=true;const id=documentID;
    try{
      const state=await request({action:'chat-state',id}) as State;if(id!==documentID)return;
      get('members').textContent=`${state.members.length} here`;get('members').title=state.members.join(', ');
      menu.update(state);
      stop.hidden=!state.activeRuns;const stopLabel=state.activeRuns>1?'Stop agents':'Stop agent';stop.setAttribute('aria-label',stopLabel);stop.title=stopLabel;
      get('chat-status').textContent=state.activeRuns>1?`${state.activeRuns} agents working…`:state.activeRuns?'Working on the document…':state.run?`Agent ${state.run.status}`:'';
      const serialized=JSON.stringify(state.messages);
      if(serialized!==last){last=serialized;const root=get('messages'),atEnd=root.scrollHeight-root.scrollTop-root.clientHeight<80;
        const expanded=new Set([...root.querySelectorAll<HTMLDetailsElement>('details[open]')].map(node=>node.dataset.activity));root.replaceChildren();
        let activity:HTMLDetailsElement|undefined;
        for(const message of state.messages){
          if(message.kind==='tool'){
            if(!activity||activity.dataset.author!==message.author){activity=document.createElement('details');activity.className='tool-activity';activity.dataset.author=message.author;activity.dataset.activity=message.id;activity.open=expanded.has(message.id);const summary=document.createElement('summary');summary.textContent=`${message.author} activity`;activity.append(summary);root.append(activity);}
            const name=message.text.split(' ')[0],completed=message.text.endsWith(' completed');
            const labels:Record<string,string>={read_document:'Read document',replace_text:'Updated text',append_paragraph:'Added a paragraph',rename_document:'Named document',configure_paper:'Updated paper settings'};
            const step=document.createElement('div');step.textContent=completed?(labels[name]??'Completed action'):'Change not applied';activity.append(step);
            if(completed&&name!=='read_document')activity.querySelector('summary')!.textContent=`${message.author} updated the document`;
            continue;
          }
          activity=undefined;
          const entry=document.createElement('div');entry.className=`message ${message.kind}`;
          const author=document.createElement(message.kind==='user'?'span':'small');
          if(message.kind==='user'){
            author.className='message-avatar';author.setAttribute('role','img');author.setAttribute('aria-label',`Message from ${message.author}`);author.title=message.author;
            author.textContent=message.author.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
          }else author.textContent=message.author;
          const body=document.createElement('div');body.textContent=message.text;entry.append(author,body);root.append(entry);
        }if(atEnd)root.scrollTop=root.scrollHeight;
      }
    }catch{get('chat-status').textContent='Chat disconnected, reconnect to send';}finally{busy=false;}
  }
  get('chat-form').onsubmit=event=>{event.preventDefault();if(!documentID||!text.value.trim())return;
    if(text.value!==pendingText||(menu.recipient==='agent')!==pendingAgent){messageID=crypto.randomUUID();pendingText=text.value;pendingAgent=menu.recipient==='agent';}
    const sent=text.value,id=documentID;send.disabled=true;
    void request({action:'chat-send',id,messageID,text:sent,agent:pendingAgent,model:menu.model}).then(()=>{if(documentID===id&&text.value===sent)text.value='';messageID=crypto.randomUUID();return refresh();}).catch(error=>{get('chat-status').textContent=error.message;}).finally(()=>{send.disabled=false;});
  };
  text.onkeydown=event=>{if(menu.keydown(event))return;if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();get<HTMLFormElement>('chat-form').requestSubmit();}};
  stop.onclick=()=>{void request({action:'chat-stop',id:documentID}).then(refresh).catch(error=>{get('chat-status').textContent=error.message;});};
  setInterval(()=>void refresh(),1000);
  return {close(){documentID=undefined;menu.reset();text.disabled=true;},open(id:string){menu.reset();documentID=id;last='';text.disabled=false;send.disabled=false;text.value='';void refresh();}};
}
