import assert from 'node:assert/strict';
import test from 'node:test';

import {
  archiveRecoveredRunForContinuation,
  buildRunContinuationPrompt,
  canContinueRecoveredRun,
  conversationSnapshot,
  reconcileRunManifest,
  prepareConversationForNextRun,
  recoverInterruptedRuns,
} from '../../app/conversation-state.js';

test('restart recovery marks a running message needs-review and preserves its run association', () => {
  const conversation = {
    id: 'conversation-1',
    title: 'Running research',
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:05:00.000Z',
    messages: [
      { id: 'user-message', role: 'user', content: 'Review this claim.', createdAt: '2026-11-17T00:01:00.000Z' },
      {
        id: 'assistant-message',
        role: 'assistant',
        content: 'Partial result',
        status: 'running',
        statusText: '正在研究',
        runId: 'research-run-1',
        createdAt: '2026-11-17T00:01:01.000Z',
      },
    ],
    activities: [{ id: 'activity-1', label: '正在执行检索', status: 'active', time: '2026-11-17T00:02:00.000Z' }],
    activeRun: {
      runId: 'research-run-1',
      assistantId: 'assistant-message',
      startedAt: '2026-11-17T00:01:01.000Z',
      status: 'running',
    },
    evidenceMode: true,
    researchMode: 'literature',
  };

  const result = recoverInterruptedRuns([conversation], { recoveredAt: '2026-11-17T00:20:00.000Z' });
  const recovered = result.conversations[0];
  const message = recovered.messages.find((item) => item.id === 'assistant-message');

  assert.equal(result.changed, true);
  assert.deepEqual(result.conversationIds, ['conversation-1']);
  assert.equal(message.status, 'needs-review');
  assert.equal(message.statusText, '应用重启，运行已中断，需要复核后可继续');
  assert.equal(message.runId, 'research-run-1');
  assert.equal(recovered.activeRun.runId, 'research-run-1');
  assert.equal(recovered.activeRun.assistantId, 'assistant-message');
  assert.equal(recovered.activeRun.status, 'running');
  assert.equal(recovered.activeRun.recoveryStatus, 'needs-review');
  assert.equal(recovered.activeRun.recoveredAt, '2026-11-17T00:20:00.000Z');
  assert.equal(recovered.activities.at(-1).label, '应用重启，研究运行需要复核后可继续');
  assert.equal(conversation.messages[1].status, 'running');
});

test('run recovery is idempotent after the first review marker is persisted', () => {
  const conversation = {
    id: 'conversation-idempotent',
    title: 'Recovered once',
    messages: [{ id: 'assistant-idempotent', role: 'assistant', status: 'running', runId: 'run-idempotent' }],
    activeRun: { runId: 'run-idempotent', assistantId: 'assistant-idempotent', status: 'running' },
    activities: [],
  };

  const first = recoverInterruptedRuns([conversation], { recoveredAt: '2026-11-17T00:20:00.000Z' });
  const second = recoverInterruptedRuns(first.conversations, { recoveredAt: '2026-11-17T00:30:00.000Z' });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(second.manifestReviewIds, ['conversation-idempotent']);
  assert.equal(second.conversations[0].activities.length, 1);
});

test('restart recovery retries manifest review when only the running message has a run ID', () => {
  const conversation = {
    id: 'conversation-message-run',
    title: 'Legacy running message',
    messages: [{
      id: 'assistant-message-run',
      role: 'assistant',
      status: 'running',
      runId: 'run-from-message',
      createdAt: '2026-11-17T00:10:00.000Z',
    }],
  };

  const result = recoverInterruptedRuns([conversation], { recoveredAt: '2026-11-17T00:20:00.000Z' });
  const recovered = result.conversations[0];

  assert.deepEqual(result.manifestReviewIds, ['conversation-message-run']);
  assert.equal(recovered.activeRun.runId, 'run-from-message');
  assert.equal(recovered.activeRun.assistantId, 'assistant-message-run');
});

test('conversation snapshots preserve an in-flight run instead of downgrading it', () => {
  const conversation = {
    id: 'conversation-2',
    title: '  In-flight research  ',
    messages: [{ id: 'message-2', status: 'running', content: 'Partial answer' }],
    activeRun: { runId: 'run-2', assistantId: 'message-2', status: 'running' },
  };

  const snapshot = conversationSnapshot(conversation);

  assert.equal(snapshot.title, 'In-flight research');
  assert.equal(snapshot.messages[0].status, 'running');
  assert.equal(snapshot.activeRun.runId, 'run-2');
  assert.equal(snapshot.activeRun.status, 'running');
  assert.equal(conversation.title, '  In-flight research  ');
});

test('a terminal Run Manifest overrides provisional review state', () => {
  const conversation = {
    id: 'conversation-3',
    title: 'Recovered research',
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:10:00.000Z',
    messages: [{
      id: 'assistant-3',
      role: 'assistant',
      status: 'needs-review',
      statusText: '应用重启，运行已中断，需要复核后可继续',
      runId: 'run-3',
    }],
    activeRun: {
      runId: 'run-3',
      assistantId: 'assistant-3',
      status: 'running',
      recoveryStatus: 'needs-review',
    },
  };

  const reconciled = reconcileRunManifest(conversation, {
    manifest: {
      runId: 'run-3',
      conversationId: 'conversation-3',
      status: 'completed',
      outputDir: '.science/outputs/run-3',
      result: 'Completed evidence summary',
      artifacts: [{ name: 'report.md', relativePath: '.science/outputs/run-3/report.md' }],
      quality: { warnings: 0, checks: [] },
      usage: { totalTokens: 1234 },
      finishedAt: '2026-11-17T00:19:00.000Z',
    },
    manifestPath: '.science/runs/conversation-3/run-3/manifest.json',
    reconciledAt: '2026-11-17T00:20:00.000Z',
  });

  assert.equal(reconciled.messages[0].status, 'done');
  assert.equal(reconciled.activeRun, null);
  assert.equal(reconciled.messages[0].content, 'Completed evidence summary');
  assert.equal(reconciled.messages[0].artifacts[0].name, 'report.md');
  assert.deepEqual(reconciled.messages[0].quality, { warnings: 0, checks: [] });
  assert.deepEqual(reconciled.messages[0].usage, { totalTokens: 1234 });
  assert.equal(reconciled.lastRecoveredRun.status, 'completed');
  assert.equal(reconciled.lastRecoveredRun.manifestPath, '.science/runs/conversation-3/run-3/manifest.json');
});

test('continuing a recovered run archives the old run before the next run starts', () => {
  const conversation = {
    id: 'conversation-4',
    title: 'Continue research',
    messages: [{
      id: 'assistant-4',
      role: 'assistant',
      status: 'needs-review',
      statusText: '应用重启，运行已中断，需要复核后可继续',
      runId: 'run-4',
    }],
    activeRun: {
      runId: 'run-4',
      assistantId: 'assistant-4',
      status: 'running',
      recoveryStatus: 'needs-review',
      manifestPath: '.science/runs/conversation-4/run-4/manifest.json',
    },
  };

  const continued = archiveRecoveredRunForContinuation(conversation, {
    continuedAt: '2026-11-17T01:00:00.000Z',
    nextRunId: 'run-5',
  });

  assert.equal(continued.activeRun, null);
  assert.equal(continued.recoveredRuns.length, 1);
  assert.equal(continued.recoveredRuns[0].runId, 'run-4');
  assert.equal(continued.recoveredRuns[0].resolution, 'continued');
  assert.equal(continued.recoveredRuns[0].continuedByRunId, 'run-5');
  assert.equal(continued.messages[0].continuationRunId, 'run-5');
  assert.match(continued.messages[0].statusText, /已转入新一轮继续研究/);
  assert.equal(conversation.activeRun.runId, 'run-4');
});

test('continuation brief carries manifest context without asking to replay side effects', () => {
  const conversation = {
    id: 'conversation-5',
    title: 'Continuation brief',
    messages: [{ id: 'assistant-5', role: 'assistant', content: 'Partial evidence summary', status: 'needs-review' }],
    activeRun: {
      runId: 'run-5',
      assistantId: 'assistant-5',
      status: 'running',
      recoveryStatus: 'needs-review',
      manifestPath: '.science/runs/conversation-5/run-5/manifest.json',
      manifest: { status: 'running', lastStep: 'Searching literature' },
    },
  };

  const prompt = buildRunContinuationPrompt(conversation, 'assistant-5');

  assert.match(prompt, /run-5/);
  assert.match(prompt, /\.science\/runs\/conversation-5\/run-5\/manifest\.json/);
  assert.match(prompt, /Searching literature/);
  assert.match(prompt, /Partial evidence summary/);
  assert.match(prompt, /Do not repeat completed tool actions/);
});

test('a normal new run cannot replace an unresolved recovered run', () => {
  const conversation = {
    id: 'conversation-6',
    title: 'Protected recovery',
    messages: [{ id: 'assistant-6', role: 'assistant', status: 'needs-review' }],
    activeRun: {
      runId: 'run-6',
      assistantId: 'assistant-6',
      status: 'running',
      recoveryStatus: 'needs-review',
      manifestPath: '.science/runs/conversation-6/run-6/manifest.json',
      manifest: { status: 'running' },
    },
  };

  assert.throws(() => prepareConversationForNextRun(conversation, {
    nextRunId: 'run-7',
    continuedAt: '2026-11-17T01:10:00.000Z',
  }), /显式继续/);
});

test('continuation requires a successfully loaded manifest', () => {
  const base = {
    id: 'conversation-7',
    messages: [{ id: 'assistant-7', role: 'assistant', status: 'needs-review' }],
    activeRun: {
      runId: 'run-7',
      assistantId: 'assistant-7',
      recoveryStatus: 'needs-review',
      manifestPath: '.science/runs/conversation-7/run-7/manifest.json',
    },
  };

  assert.equal(canContinueRecoveredRun(base), false);
  assert.equal(canContinueRecoveredRun({
    ...base,
    activeRun: { ...base.activeRun, manifestError: 'manifest unavailable' },
  }), false);
  assert.equal(canContinueRecoveredRun({
    ...base,
    activeRun: { ...base.activeRun, manifest: { status: 'running' } },
  }), true);
});
