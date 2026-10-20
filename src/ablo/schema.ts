import {defineSchema,model,z} from '@abloatai/ablo/schema';

export const schema=defineSchema({
  forumCodexConnections:model({payload:z.string()}),
  forumDocuments:model({workspace:z.string().default('local'),time:z.number(),title:z.string(),doc:z.string(),version:z.number().int(),layout:z.string(),paper:z.string()}),
  forumSteps:model({document:z.string(),version:z.number().int(),step:z.string(),client:z.string()}),
  forumReceipts:model({digest:z.string(),result:z.string()}),
  forumMessages:model({document:z.string(),author:z.string(),kind:z.string(),text:z.string(),sender:z.string(),intent:z.string(),time:z.number()}),
  forumRuns:model({document:z.string(),author:z.string(),status:z.string(),owner:z.string(),time:z.number()}),
});
export default schema;
