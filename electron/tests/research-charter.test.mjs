import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approveResearchCharter,
  charterNeedsReapproval,
  currentApprovedResearchCharter,
  currentResearchCharter,
  normalizeResearchCharterState,
  researchCharterFieldsEqual,
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
    revisionOrigin: 'agent',
    updatedAt: timestamp,
    generatedByRunId: 'run-charter-draft',
  });
  const current = currentResearchCharter(state);

  assert.equal(current.version, 1);
  assert.equal(current.status, 'draft');
  assert.equal(current.question, 'What works?');
  assert.equal(current.revisionOrigin, 'agent');
  assert.equal(current.generatedByRunId, 'run-charter-draft');
  assert.equal(current.createdAt, timestamp);
  assert.equal(currentApprovedResearchCharter(state), null);
  assert.throws(() => saveResearchCharterDraft(state, charter({ scope: '' }), { updatedAt: timestamp }), /scope|范围/);
  assert.throws(() => saveResearchCharterDraft(state, charter({ dataPolicy: 'public' }), { updatedAt: timestamp }), /数据处理政策/);
});


test('revision authorship uses revisionOrigin and accepts legacy source values', () => {
  let state = saveResearchCharterDraft(undefined, charter(), {
    revisionOrigin: 'agent',
    updatedAt: timestamp,
    generatedByRunId: 'run-revision-origin',
  });
  assert.equal(currentResearchCharter(state).revisionOrigin, 'agent');
  assert.equal(currentResearchCharter(state).source, undefined);

  state = normalizeResearchCharterState({
    currentVersion: 1,
    revisions: [{
      ...charter(),
      version: 1,
      status: 'draft',
      source: 'user',
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  });
  assert.equal(currentResearchCharter(state).revisionOrigin, 'user');
});

test('editing a draft appends a new immutable version', () => {
  let state = saveResearchCharterDraft(undefined, charter(), { updatedAt: timestamp });
  state = saveResearchCharterDraft(state, charter({ scope: 'Updated scope.' }), {
    updatedAt: '2026-11-19T08:01:00.000Z',
  });

  assert.equal(state.revisions.length, 2);
  assert.equal(state.revisions[0].version, 1);
  assert.equal(state.revisions[0].scope, charter().scope);
  assert.equal(currentResearchCharter(state).version, 2);
  assert.equal(currentResearchCharter(state).scope, 'Updated scope.');
  assert.equal(currentResearchCharter(state).createdAt, '2026-11-19T08:01:00.000Z');
});

test('approving the current draft records an immutable approved version', () => {
  let state = saveResearchCharterDraft(undefined, charter(), { updatedAt: timestamp });
  state = approveResearchCharter(state, { approvedAt: '2026-11-19T08:02:00.000Z' });
  const approved = currentApprovedResearchCharter(state);

  assert.equal(state.revisions.length, 2);
  assert.equal(state.revisions[0].status, 'draft');
  assert.equal(currentResearchCharter(state).status, 'approved');
  assert.equal(approved.version, 2);
  assert.equal(approved.supersedes, 1);
  assert.equal(approved.approvedAt, '2026-11-19T08:02:00.000Z');
  assert.equal(charterNeedsReapproval(state), false);
});

test('editing an approved charter creates a re-approval revision and retains history', () => {
  let state = saveResearchCharterDraft(undefined, charter(), { updatedAt: timestamp });
  state = approveResearchCharter(state, { approvedAt: '2026-11-19T08:02:00.000Z' });
  state = saveResearchCharterDraft(state, charter({ question: 'Which fasting protocol works?' }), {
    revisionOrigin: 'user',
    updatedAt: '2026-11-19T08:03:00.000Z',
  });

  assert.equal(state.revisions.length, 3);
  assert.equal(state.revisions[1].status, 'approved');
  assert.equal(state.revisions[1].question, charter().question);
  assert.equal(currentResearchCharter(state).version, 3);
  assert.equal(currentResearchCharter(state).status, 'draft');
  assert.equal(currentResearchCharter(state).supersedes, 2);
  assert.equal(currentApprovedResearchCharter(state), null);
  assert.equal(charterNeedsReapproval(state), true);

  state = approveResearchCharter(state, { approvedAt: '2026-11-19T08:04:00.000Z' });
  assert.equal(currentApprovedResearchCharter(state).version, 4);
  assert.equal(state.revisions.length, 4);
});

test('charter field comparison ignores revision metadata and surrounding whitespace', () => {
  const approved = {
    ...charter(),
    version: 7,
    status: 'approved',
    supersedes: 6,
    generatedByRunId: 'run-approved-charter',
  };
  const edited = charter({ question: '  How does intermittent fasting affect metabolic health?  ' });

  assert.equal(researchCharterFieldsEqual(approved, edited), true);
  assert.equal(researchCharterFieldsEqual(approved, charter({ scope: 'A different scope.' })), false);
});


test('a later agent draft creates a new revision after a user-edited reapproval draft', () => {
  let state = saveResearchCharterDraft(undefined, charter(), {
    revisionOrigin: 'agent',
    updatedAt: timestamp,
    generatedByRunId: 'run-draft-1',
  });
  state = approveResearchCharter(state, { approvedAt: '2026-11-19T08:02:00.000Z' });
  state = saveResearchCharterDraft(state, charter({ question: 'User revised question.' }), {
    revisionOrigin: 'user',
    updatedAt: '2026-11-19T08:03:00.000Z',
  });
  state = saveResearchCharterDraft(state, charter({ question: 'Agent revised question.' }), {
    revisionOrigin: 'agent',
    updatedAt: '2026-11-19T08:04:00.000Z',
    generatedByRunId: 'run-draft-2',
  });

  assert.equal(state.revisions.length, 4);
  assert.equal(state.revisions[2].version, 3);
  assert.equal(state.revisions[2].status, 'draft');
  assert.equal(state.revisions[2].question, 'User revised question.');
  assert.equal(currentResearchCharter(state).version, 4);
  assert.equal(currentResearchCharter(state).status, 'draft');
  assert.equal(currentResearchCharter(state).supersedes, 3);
  assert.equal(currentResearchCharter(state).question, 'Agent revised question.');
  assert.equal(currentResearchCharter(state).generatedByRunId, 'run-draft-2');
});


test('an identical agent draft still records agent provenance over a user draft', () => {
  let state = saveResearchCharterDraft(undefined, charter(), {
    revisionOrigin: 'user',
    updatedAt: timestamp,
  });
  state = saveResearchCharterDraft(state, charter(), {
    revisionOrigin: 'agent',
    updatedAt: '2026-11-19T08:05:00.000Z',
    generatedByRunId: 'run-identical-agent-draft',
  });

  assert.equal(state.revisions.length, 2);
  assert.equal(state.revisions[0].revisionOrigin, 'user');
  assert.equal(currentResearchCharter(state).revisionOrigin, 'agent');
  assert.equal(currentResearchCharter(state).generatedByRunId, 'run-identical-agent-draft');
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
