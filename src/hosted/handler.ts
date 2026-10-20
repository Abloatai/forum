import type {IncomingMessage,ServerResponse} from 'node:http';
import {hostedService} from './index.js';
import {waitUntil} from '@vercel/functions';
const service=hostedService({waitUntil});
export const config={maxDuration:300};
export default async function handler(req:IncomingMessage&{body?:unknown},res:ServerResponse){
  try{
    let body:string;
    if(req.body!==undefined)body=typeof req.body==='string'?req.body:JSON.stringify(req.body);
    else{const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>1_048_576){res.writeHead(413).end();return;}chunks.push(bytes);}body=Buffer.concat(chunks).toString('utf8');}
    const headers=new Headers();for(const[name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
    const response=await service(new Request('https://forum.abloatai.com/api/rpc',{method:req.method??'POST',headers,...(req.method==='POST'?{body}:{})}));
    const cookies=response.headers.getSetCookie();res.writeHead(response.status,{...Object.fromEntries(response.headers),...(cookies.length?{'set-cookie':cookies}:{})});res.end(await response.text());
  }catch{res.writeHead(503,{'cache-control':'no-store'}).end('{"error":"service_unavailable"}');}
}
