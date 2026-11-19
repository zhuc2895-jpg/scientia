import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateResearchRunPolicy } from '../../app/research-run-policy.js';

function charter(overrides = {}) {
  return {
    version: 1,
    status: 'approved',
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

test('an unapproved standard draft cannot weaken an approved local-only policy', () => {
  const result = evaluateResearchRunPolicy({
    stageKey: 'scoping',
    charter: {
      current: charter({ version: 2, status: 'draft', dataPolicy: 'standard' }),
      approved: charter({ version: 1, dataPolicy: 'local-only' }),
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, 'local-only');
  assert.equal(result.policy, 'local-only');
});


test('sensitive policy requires explicit confirmation', () => {
  const result = evaluateResearchRunPolicy({
    stageKey: 'evidence',
    charter: {
      current: charter({ status: 'draft', dataPolicy: 'sensitive' }),
      approved: charter({ dataPolicy: 'standard' }),
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, 'sensitive-confirmation-required');
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.policy, 'sensitive');
});


test('confirmed sensitive transmission is allowed', () => {
  const result = evaluateResearchRunPolicy({
    stageKey: 'evidence',
    charter: {
      current: charter({ status: 'draft', dataPolicy: 'sensitive' }),
      approved: charter({ dataPolicy: 'standard' }),
    },
    sensitiveTransmissionConfirmed: true,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.code, 'allowed');
  assert.equal(result.policy, 'sensitive');
});


test('a post-Scoping run requires an approved Charter', () => {
  const result = evaluateResearchRunPolicy({
    stageKey: 'evidence',
    charter: {
      current: charter({ status: 'draft', dataPolicy: 'standard' }),
      approved: null,
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, 'approved-charter-required');
});
