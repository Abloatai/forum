import {getSchema, type JSONContent} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
// Extracted core of Decks createTextEditorExtensions + DocumentProvider.
// Keep document headings; omit slide themes, AI nodes and organization services.
export function createTextEditorExtensions() {
  return [StarterKit.configure({link: false}), Placeholder.configure({placeholder: 'Start writing…'})];
}
export const schema = getSchema(createTextEditorExtensions());
export const emptyDocument: JSONContent = {type: 'doc', content: [{type: 'paragraph'}]};
export const defaultPaper={width:794,height:1123,marginTop:96,marginRight:96,marginBottom:96,marginLeft:96};
export type Paper=typeof defaultPaper;
export function paperSettings(value:unknown):Paper{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==6)throw new Error('invalid_paper');
  const result={} as Paper;
  for(const key of Object.keys(defaultPaper) as (keyof Paper)[]){const n=(value as Paper)[key];if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>3600)throw new Error('invalid_paper');result[key]=n;}
  if(result.width<240||result.width>2400||result.height<320||result.width-result.marginLeft-result.marginRight<120||result.height-result.marginTop-result.marginBottom<128)throw new Error('invalid_paper');
  return result;
}
export type Snapshot = {id: string; title: string; layout?: 'page'|'flow'; paper?:Paper; doc: JSONContent; version: number};
export type Changes = {title: string; layout: 'page'|'flow'; paper:Paper; version: number; steps: unknown[]; clientIDs: string[]};
export type Draft = {id: string; clientID: string; base: Snapshot; steps: unknown[]};
export type Request = {action: string; [key: string]: unknown};
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw new Error('invalid_id');
}
export function validateRequest(value: unknown): asserts value is Request {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 1_000_000) throw new Error('invalid_request');
  if (!['list','create','open','changes','submit','rename','layout','paper','chat-state','chat-send','chat-stop'].includes(String((value as Request).action))) throw new Error('invalid_request');
}
