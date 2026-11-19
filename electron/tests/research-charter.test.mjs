import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approveResearchCharter,
  charterNeedsReapproval,
  currentApprovedResearchCharter,
  currentResearchCharter,
  normalizeResearchCharterState,
  saveResearchCharterDraft,
} from '../../app/research-charter.js';

const timestamp = '2026-11-19T08:00:00.000Z';

function charter(overrides = {}) {
  return {
    question: 'How does intermittent fasting affect metabolic health?',
    contribution: 'Reconcile trial evidence across clinically relevant outcomes.',
    scope: 'Adults without diagnosed metabolic disease; 2015-2026.',
    methodConstraints: 'Prefer randomized trials; distinguish association from causation.',
    successCriteria: 'A traceable evidence map and a defensible review manuscript.',
    paperType: 'Review',
    citationStyle: 'Vancouver',
    dataPolicy: 'standard',
    ...overrides,
  };
}

test('a draft charter requires every field and normalizes its values', () => {
  const state = saveResearchCharterDraft(undefined, charter({ question: '  What works?  ' }), {
    source: 'agent',
    updatedAt: timestamp,
    generatedByRunId: 'run-charter-draft',
  });
  const current = currentResearchCharter(state);

  assert.equal(current.version, 1);
  assert.equal(current.status, 'draft');
  assert.equal(current.question, 'What works?');
  assert.equal(current.source, 'agent');
  assert.equal(current.generatedByRunId, 'run-charter-draft');
  assert.equal(current.createdAt, timestamp);
  assert.equal(currentApprovedResearchCharter(state), null);
  assert.throws(() => saveResearchCharterDraft(state, charter({ scope: '' }), { updatedAt: timestamp }), /scope|范围/);
  assert.throws(() => saveResearchCharterDraft(state, charter({ dataPolicy: 'public' }), { updatedAt: timestamp }), /数据处理政策/);
});

test('editing a draft updates it without creating a new version', () => {
  let state = saveResearchCharterDraft(undefined, charter(), { updatedAt: timestamp });
  state = saveResearchCharterDraft(state, charter({ scope: 'Updated scope.' }), {
    updatedAt: '2026-11-19T08:01:00.000Z',
  });

  assert.equal(state.revisions.length, 1);
  assert.equal(currentResearchCharter(state).version, 1);
  assert.equal(currentResearchCharter(state).scope, 'Updated scope.');
  assert.equal(currentResearchCharter(state).createdAt, timestamp);
  assert.equal(currentResearchCharter(state).updatedAt, '2026-11-19T08:01:00.000Z');
});

test('approving the current draft records an immutable approved version', () => {
  let state = saveResearchCharterDraft(undefined, charter(), { updatedAt: timestamp });
  state = approveResearchCharter(state, { approvedAt: '2026-11-19T08:02:00.000Z' });
  const approved = currentApprovedResearchCharter(state);

  assert.equal(currentResearchCharter(state).status, 'approved');
  assert.equal(approved.version, 1);
  assert.equal(approved.approvedAt, '2026-11-19T08:02:00.000Z');
  assert.equal(charterNeedsReapproval(state), false);
});

test('editing an approved charter creates a re-approval revision and retains history', () => {
  let state = saveResearchCharterDraft(undefined, charter(), { updatedAt: timestamp });
  state = approveResearchCharter(state, { approvedAt: '2026-11-19T08:02:00.000Z' });
  state = saveResearchCharterDraft(state, charter({ question: 'Which fasting protocol works?' }), {
    source: 'user',
    updatedAt: '2026-11-19T08:03:00.000Z',
  });

  assert.equal(state.revisions.length, 2);
  assert.equal(state.revisions[0].status, 'approved');
  assert.equal(state.revisions[0].question, charter().question);
  assert.equal(currentResearchCharter(state).version, 2);
  assert.equal(currentResearchCharter(state).status, 'draft');
  assert.equal(currentResearchCharter(state).supersedes, 1);
  assert.equal(currentApprovedResearchCharter(state), null);
  assert.equal(charterNeedsReapproval(state), true);

  state = approveResearchCharter(state, { approvedAt: '2026-11-19T08:04:00.000Z' });
  assert.equal(currentApprovedResearchCharter(state).version, 2);
  assert.equal(state.revisions.length, 2);
});

test('normalization ignores corrupt revisions and keeps the latest coherent draft', () => {
  const state = normalizeResearchCharterState({
    currentVersion: 9,
    approvedVersion: 1,
    revisions: [
      { ...charter(), version: 1, status: 'approved', createdAt: timestamp, updatedAt: timestamp, approvedAt: timestamp },
      { ...charter(), version: 'bad', status: 'draft' },
      { ...charter(), version: 2, status: 'draft', createdAt: timestamp, updatedAt: timestamp },
    ],
  });

  assert.equal(state.currentVersion, 2);
  assert.equal(state.revisions.length, 2);
  assert.equal(currentResearchCharter(state).version, 2);
  assert.equal(currentApprovedResearchCharter(state), null);
});
