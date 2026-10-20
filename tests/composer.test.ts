import {test} from 'node:test';
import assert from 'node:assert/strict';
import {composerToken, insertReference, referenceRanges} from '../src/renderer/matching.js';

test('composer completes slash/member/document tokens at the caret without rewriting surrounding text', () => {
  const text = 'Check #exa then ask @sam';
  const token = composerToken(text, 10)!;
  assert.deepEqual(token, {trigger:'#',query:'exa',start:6,end:10});
  assert.equal(insertReference(text,token,'#Example document'),'Check #Example document  then ask @sam');
  assert.equal(composerToken(text,text.length)?.trigger,'@');
  assert.deepEqual(composerToken('Draft /te afterwards',9),{trigger:'/',query:'te',start:6,end:9});
  assert.deepEqual(composerToken('Hello\n@',7),{trigger:'@',query:'',start:6,end:7});
  for (const value of ['name@example.test','https://example.test/#section','# Heading','literal @ name','text/agent']) assert.equal(composerToken(value,value.length),null);
  for (const cursor of [-1,100,1.5]) assert.equal(composerToken('@me',cursor),null);
  assert.equal(insertReference('😀 #doc end',{start:3,end:7},'#Plan'),'😀 #Plan  end');
});

test('known references match whole multi-word names and punctuation, not URLs or partial names', () => {
  const references=['@Member abcd','#Plan','#Plan for launch'];
  const text='Ask @Member abcd, about #Plan for launch. Then #Plan';
  assert.deepEqual(referenceRanges(text,references).map(({start,end})=>text.slice(start,end)),['@Member abcd','#Plan for launch','#Plan']);
  for(const value of ['name@Member abcd','https://example.test/#Plan','#Planning','#unknown']) assert.deepEqual(referenceRanges(value,references),[]);
});
