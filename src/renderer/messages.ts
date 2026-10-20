import {createElement as h} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Streamdown,defaultRehypePlugins} from 'streamdown';

type Message={id:string;author:string;kind:string;text:string};
const authorName=(author:string)=>author.replace(/^(Agent|Codex|Scripted test agent) [a-f0-9]{4}$/,'$1');
const rehypePlugins=[defaultRehypePlugins.sanitize!,defaultRehypePlugins.harden!];
const components={
  strong:({children}:{children?:React.ReactNode})=>h('strong',null,children),
  img:({alt}:{alt?:string})=>h('span',null,alt?`[Image: ${alt}]`:'[Image]'),
  a:({href,children}:{href?:string;children?:React.ReactNode})=>{
    let target:URL|undefined;try{target=new URL(href??'');}catch{/* Invalid links remain text. */}
    return target&&['http:','https:'].includes(target.protocol)&&!target.username&&!target.password
      ?h('a',{href:target.href,target:'_blank',rel:'noopener noreferrer'},children):h('span',null,children);
  },
};
function rows(messages:Message[]){
  const result:React.ReactNode[]=[];
  for(let index=0;index<messages.length;index++){
    const message=messages[index],author=authorName(message.author);
    if(message.kind==='tool'){
      const tools=[message];while(messages[index+1]?.kind==='tool'&&messages[index+1].author===message.author)tools.push(messages[++index]);
      const updated=tools.some(tool=>tool.text.endsWith(' completed')&&!tool.text.startsWith('read_document '));
      const labels:Record<string,string>={read_document:'Read document',replace_text:'Updated text',append_paragraph:'Added a paragraph',rename_document:'Named document',configure_paper:'Updated paper settings'};
      result.push(h('details',{key:message.id,className:'tool-activity'},h('summary',null,`${author} ${updated?'updated the document':'activity'}`),...tools.map(tool=>h('div',{key:tool.id},tool.text.endsWith(' completed')?(labels[tool.text.split(' ')[0]]??'Completed action'):'Change not applied'))));continue;
    }
    const user=message.kind==='user';
    result.push(h('div',{key:message.id,className:`message ${message.kind}`},
      user?h('span',{className:'message-avatar',role:'img','aria-label':`Message from ${message.author}`,title:message.author},message.author.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase()):h('small',null,author),
      message.kind==='assistant'?h(Streamdown,{mode:'static',skipHtml:true,rehypePlugins,controls:false,lineNumbers:false,linkSafety:{enabled:false},components,className:'message-markdown'},message.text):h('div',null,message.text),
    ));
  }
  return result;
}
export function messageList(container:HTMLElement){
  const root=createRoot(container);
  return {render(messages:Message[]){const atEnd=container.scrollHeight-container.scrollTop-container.clientHeight<80;flushSync(()=>root.render(rows(messages)));if(atEnd)container.scrollTop=container.scrollHeight;},clear(){flushSync(()=>root.render(null));}};
}
