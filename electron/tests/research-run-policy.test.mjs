import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateResearchRunPolicy } from '../../app/research-run-policy.js';

function charter(overrides = {}) {
  return {
    version: 1,
    status: 'draft',
    question: 'What is being studied?',
    contribution: 'Clarify the evidence.',
    scope: 'Current project workspace.',
    methodConstraints: 'Do not fabricate evidence.',
    successCriteria: 'A traceable result.',
    paperType: 'Review',
    citationStyle: 'Vancouver',
    dataPolicy: 'standard',
    ...overrides,
  };
}

test('local-only policy blocks a scoping run before external model use', () => {
  const result = evaluateResearchRunPolicy({
    stageKey: 'scoping',
    charter: {
      current: charter({ dataPolicy: 'local-only' }),
      approved: null,
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, 'local-only');
  assert.equal(result.policy, 'local-only');
  assert.match(result.message, /local-only/);
});


test('sensitive policy requires explicit confirmation before external transmission', () => {
  const result = evaluateResearchRunPolicy({
    stageKey: 'scoping',
    charter: {
      current: charter({ dataPolicy: 'sensitive' }),
      approved: null,
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, 'sensitive-confirmation-required');
  assert.equal(result.policy, 'sensitive');
  assert.equal(result.requiresConfirmation, true);
});


test('confirmed sensitive transmission allows a scoping draft run', () => {
  const result = evaluateResearchRunPolicy({
    stageKey: 'scoping',
    charter: {
      current: charter({ dataPolicy: 'sensitive' }),
      approved: null,
    },
    sensitiveTransmissionConfirmed: true,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.code, 'allowed');
  assert.equal(result.policy, 'sensitive');
  assert.equal(result.approvedCharter, null);
  assert.equal(result.charterDraftMode, true);
});


test('a post-Scoping run requires an approved Charter', () => {
  const result = evaluateResearchRunPolicy({
    stageKey: 'evidence',
    charter: {
      current: charter(),
      approved: null,
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, 'approved-charter-required');
  assert.match(result.message, /approved Research Charter/);
});
