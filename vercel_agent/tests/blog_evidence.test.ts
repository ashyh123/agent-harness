import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlogReview } from '../blog_evidence.js';

const valid = { checks: ['summary_facts', 'quote_supports_core', 'takeaway_is_inference']
  .map(id => ({ id, verdict: 'supported', reason: '支持' })) };
test('blog review requires complete, unique, valid evidence judgments; insufficient never permits save', () => {
  assert.equal(parseBlogReview(JSON.stringify(valid)).passed, true);
  for (const data of [null, {}, { checks: valid.checks.slice(1) },
    { checks: [valid.checks[0], valid.checks[0], valid.checks[2]] },
    { checks: valid.checks.map(c => ({ ...c, reason: '' })) },
    { checks: valid.checks.map(c => ({ ...c, verdict: true })) }])
    assert.equal(parseBlogReview(JSON.stringify(data)).passed, false);
  const unsupported = parseBlogReview(JSON.stringify({ checks: valid.checks.map(c =>
    c.id === 'quote_supports_core' ? { ...c, verdict: 'insufficient', reason: '真实但无关' } : c) }));
  assert.equal(unsupported.passed, false);
  assert.match(unsupported.issues.join(''), /真实但无关/);
});

test('a positive reviewer verdict requires grounded core evidence and covers absolute claims', () => {
  const evidence = { summary: '新的 Responses API 支持内置工具，但无法接入客户 VPC。',
    evidence_quote: 'The Responses API supports built-in tools.',
    sources: ['The Responses API supports built-in tools. Customers can peer networks or run the harness in their own environment.'] };
  const core_match = { claim: 'Responses API 支持内置工具', evidence_field: 'evidence_quote' };
  assert.equal(parseBlogReview(JSON.stringify(valid), evidence).passed, false, 'labels alone cannot permit saving');
  assert.equal(parseBlogReview(JSON.stringify({ ...valid, core_match, risk_checks: [] }), evidence).passed, false,
    'a positive overall verdict cannot omit the VPC absolute claim');
  const risk = { claim: '无法接入客户 VPC', source_quote: 'Customers can peer networks or run the harness in their own environment.', verdict: 'unsupported' };
  assert.equal(parseBlogReview(JSON.stringify({ ...valid, core_match, risk_checks: [risk] }), evidence).passed, false);
  const neutral = { ...evidence, summary: '新的 Responses API 支持内置工具。' };
  assert.equal(parseBlogReview(JSON.stringify({ ...valid, core_match, risk_checks: [] }), neutral).passed, true);
  assert.equal(parseBlogReview(JSON.stringify({ ...valid, core_match: { ...core_match, evidence_field: 'source' }, risk_checks: [] }), neutral).passed, false);
  assert.equal(parseBlogReview(JSON.stringify({ ...valid, core_match: { ...core_match, claim: '不存在于摘要的结论' }, risk_checks: [] }), neutral).passed, false);
  assert.equal(parseBlogReview(JSON.stringify({ ...valid, core_match, risk_checks: [{ ...risk, source_quote: 'fabricated source', verdict: 'supported' }] }), evidence).passed, false);
});
