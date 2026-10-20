import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computeBoundariesFromMeasurements} from '../src/document/pagination.js';
test('Decks pagination keeps headings with following blocks without changing positions', () => {
  const blocks = [
    {pos:0,measurement:{height:800,marginTop:0,marginBottom:0}},
    {pos:10,measurement:{height:50,marginTop:0,marginBottom:10,keepWithNext:true}},
    {pos:20,measurement:{height:100,marginTop:10,marginBottom:0}},
  ];
  const before = JSON.stringify(blocks);
  const layout = computeBoundariesFromMeasurements(blocks,{pageHeight:1123,pageMarginTop:96,pageMarginBottom:96,pageGap:32});
  assert.equal(layout.pageCount,2);
  assert.equal(layout.boundaries[0].pos,10);
  assert.equal(layout.blocks[1].page,layout.blocks[2].page);
  assert.ok(layout.boundaries.every(b=>b.spacerHeight>=0));
  assert.equal(JSON.stringify(blocks),before);
});
