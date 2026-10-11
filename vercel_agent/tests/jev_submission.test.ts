import test from 'node:test';
import assert from 'node:assert/strict';
import { jevSubmissionClassifier } from '../jev_submission.js';
test('Jev only replaces capability/complexity, preserves route/acceptance and caches identical submissions', async () => {
  let calls=0;
  const classify=jevSubmissionClassifier(async()=>{},async(_url, init)=>{
    calls++;
    assert.ok(JSON.parse(String(init?.body)).state.runtime_capabilities.shell.includes('automatically'));
    assert.deepEqual(Object.keys(JSON.parse(String(init?.body)).questions),['capability','complexity']);
    return new Response(JSON.stringify({answers:{capability:{choice:'coding'},complexity:{choice:'simple'}},usage:{input_tokens:10}}));
  });
  const original={key:'x',task:'write a file',capability:'general' as const,complexity:'complex' as const,route:'codex',acceptance:{expected_files:['x.txt']}};
  const result=await classify(original);await classify(original);
  assert.deepEqual(result,{...original,capability:'coding',complexity:'simple'});assert.equal(calls,1);
});
test('invalid Jev response falls back to original coordinator judgment',async()=>{
  const classify=jevSubmissionClassifier(async()=>{},async()=>new Response('{}',{status:500}));
  const input={key:'x',task:'hi',capability:'general' as const,complexity:'simple' as const,acceptance:{expected_files:['result.md']}};
  assert.deepEqual(await classify(input),input);
});
test('draft without classification cannot silently fall back when Jev fails', async () => {
  const classify=jevSubmissionClassifier(async()=>{},async()=>new Response('{}',{status:500}));
  await assert.rejects(classify({key:'draft',task:'calculate',acceptance:{expected_files:['result.md']}} as any),/任务未提交/);
});
test('Jev fills an unclassified draft without changing its acceptance or route',async()=>{
  const classify=jevSubmissionClassifier(async()=>{},async()=>new Response(JSON.stringify({answers:{capability:{choice:'math'},complexity:{choice:'simple'}}})));
  const draft={key:'draft',task:'calculate',route:'auto',acceptance:{expected_files:['result.md']}};
  assert.deepEqual(await classify(draft as any),{...draft,capability:'math',complexity:'simple'});
});
