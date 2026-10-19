import {randomUUID} from 'node:crypto';
import {EditorState} from '@tiptap/pm/state';
import {schema, type Request, type Snapshot} from '../document/index.js';

const paperSchema={type:'object',properties:{width:{type:'number'},height:{type:'number'},marginTop:{type:'number'},marginRight:{type:'number'},marginBottom:{type:'number'},marginLeft:{type:'number'}},required:['width','height','marginTop','marginRight','marginBottom','marginLeft'],additionalProperties:false};
export const documentTools = [
  {name:'read_document', description:'Read the current document and version. Read again after stale_version.', inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'rename_document',description:'Give this document a concise descriptive title. Read first; provide its current title and version to avoid overwriting another naming change.',inputSchema:{type:'object',properties:{version:{type:'integer'},expectedTitle:{type:'string'},title:{type:'string'}},required:['version','expectedTitle','title'],additionalProperties:false}},
  {name:'configure_paper',description:'Set page width, height and all four margins in CSS pixels at 96 DPI. Read first and supply current paper settings and version. The page automatically fits the window; this never edits text.',inputSchema:{type:'object',properties:{version:{type:'integer'},expectedPaper:paperSchema,paper:paperSchema},required:['version','expectedPaper','paper'],additionalProperties:false}},
  {name:'replace_text', description:'Replace one unique, exact text occurrence within a text block. Requires the version just read; preserves surrounding formatting and concurrent edits.', inputSchema:{type:'object',properties:{version:{type:'integer'},find:{type:'string'},text:{type:'string'}},required:['version','find','text'],additionalProperties:false}},
  {name:'append_paragraph', description:'Append a paragraph to the current document. Requires the version just read.', inputSchema:{type:'object',properties:{version:{type:'integer'},text:{type:'string'}},required:['version','text'],additionalProperties:false}},
];
export async function documentTool(request:(input:Request)=>unknown, id:string, clientID:string, name:string, args:Record<string,unknown>) {
  const snapshot = await request({action:'open',id}) as Snapshot;
  const doc = schema.nodeFromJSON(snapshot.doc);
  if (name === 'read_document') return {...snapshot, text:doc.textBetween(0,doc.content.size,'\n')};
  if(name==='rename_document')return request({action:'rename',id,version:args.version,expectedTitle:args.expectedTitle,title:args.title});
  if(name==='configure_paper')return request({action:'paper',id,version:args.version,expectedPaper:args.expectedPaper,paper:args.paper});
  if (!['replace_text','append_paragraph'].includes(name)) throw new Error('unknown_tool');
  if (!Number.isSafeInteger(args.version) || args.version !== snapshot.version) throw new Error('stale_version: read_document again before editing');
  if (typeof args.text !== 'string' || args.text.length > 20_000 || (name === 'append_paragraph' && !args.text)) throw new Error('invalid_text');
  const tr = EditorState.create({schema,doc}).tr;
  if (name === 'append_paragraph') tr.insert(doc.content.size,schema.nodes.paragraph.create(null,schema.text(args.text)));
  else {
    if (typeof args.find !== 'string' || !args.find || args.find.length > 20_000) throw new Error('invalid_find');
    const matches:number[] = [], find = args.find;
    // Search each text block, including text split by marks. Reject ambiguous matches.
    doc.descendants((node,pos) => {
      if (!node.isTextblock) return;
      const text = node.textBetween(0,node.content.size,'','\ufffc');
      for (let offset=text.indexOf(find); offset>=0; offset=text.indexOf(find,offset+1)) matches.push(pos+1+offset);
      return false;
    });
    if (matches.length !== 1) throw new Error('text_not_unique: read_document and choose a unique exact passage');
    tr.insertText(args.text,matches[0],matches[0]+find.length);
  }
  const result=await request({action:'submit',id,version:snapshot.version,operationId:randomUUID(),clientID,steps:tr.steps.map(step=>step.toJSON())}) as {accepted:boolean};
  if(!result.accepted)throw new Error('stale_version: read_document again before editing');
  return result;
}
