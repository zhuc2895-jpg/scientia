import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildResearchStageGraph,
  completeResearchStage,
  createInitialResearchStageState,
  markResearchStageNotApplicable,
  normalizeResearchStageState,
  reopenResearchStage,
} from '../../app/research-stages.js';

const timestamp = '2026-11-18T10:00:00.000Z';

test('the initial stage graph exposes the six ordered research stages and a concrete next action', () => {
  const graph = buildResearchStageGraph(createInitialResearchStageState());

  assert.deepEqual(
    graph.stages.map((stage) => stage.englishLabel),
    ['Scoping', 'Evidence', 'Inquiry', 'Synthesis', 'Manuscript', 'Release'],
  );
  assert.equal(graph.currentStageKey, 'scoping');
  assert.equal(graph.currentStage.englishLabel, 'Scoping');
  assert.equal(graph.stages[0].status, 'current');
  assert.equal(graph.stages[1].status, 'pending');
  assert.equal(graph.stages[1].isLocked, true);
  assert.match(graph.stages[1].lockReason, /Scoping/);
  assert.deepEqual(graph.nextAction.allowedActions, ['complete', 'not_applicable']);
  assert.match(graph.nextAction.description, /Evidence/);
});

test('completing the current stage advances the graph and survives serialization', () => {
  const completed = completeResearchStage(createInitialResearchStageState(), 'scoping', { completedAt: timestamp });
  const graph = buildResearchStageGraph(completed);

  assert.equal(graph.currentStageKey, 'evidence');
  assert.equal(graph.stages[0].status, 'completed');
  assert.equal(graph.stages[0].completedAt, timestamp);
  assert.equal(graph.stages[1].status, 'current');
  assert.equal(graph.stages[2].isLocked, true);
  assert.match(graph.stages[2].lockReason, /Evidence/);

  const restored = normalizeResearchStageState(JSON.parse(JSON.stringify(completed)));
  assert.deepEqual(buildResearchStageGraph(restored), graph);
});

test('a stage can be explicitly skipped only with a recorded reason', () => {
  const initial = completeResearchStage(createInitialResearchStageState(), 'scoping', { completedAt: timestamp });

  assert.throws(
    () => markResearchStageNotApplicable(initial, 'evidence', '   ', { markedAt: timestamp }),
    /原因/,
  );

  const skipped = markResearchStageNotApplicable(initial, 'evidence', 'No external evidence is available.', { markedAt: timestamp });
  const graph = buildResearchStageGraph(skipped);

  assert.equal(graph.currentStageKey, 'inquiry');
  assert.equal(graph.stages[1].status, 'not_applicable');
  assert.equal(graph.stages[1].notApplicableReason, 'No external evidence is available.');
  assert.equal(graph.stages[1].isLocked, false);
});

test('completed stages can be re-entered without erasing later completed stages', () => {
  let state = completeResearchStage(createInitialResearchStageState(), 'scoping', { completedAt: timestamp });
  state = completeResearchStage(state, 'evidence', { completedAt: timestamp });
  state = reopenResearchStage(state, 'scoping', { reopenedAt: timestamp });

  let graph = buildResearchStageGraph(state);
  assert.equal(graph.currentStageKey, 'scoping');
  assert.equal(graph.currentStage.isCompleted, true);
  assert.equal(graph.nextAction.allowedActions.includes('not_applicable'), false);

  state = completeResearchStage(state, 'scoping', { completedAt: timestamp });
  graph = buildResearchStageGraph(state);
  assert.equal(graph.currentStageKey, 'inquiry');
  assert.equal(graph.stages[1].status, 'completed');
});

test('out-of-order and unknown stage mutations are rejected', () => {
  const initial = createInitialResearchStageState();

  assert.throws(() => completeResearchStage(initial, 'evidence', { completedAt: timestamp }), /当前阶段/);
  assert.throws(() => completeResearchStage(initial, 'not-a-stage', { completedAt: timestamp }), /阶段/);
  assert.throws(() => reopenResearchStage(initial, 'scoping', { reopenedAt: timestamp }), /完成/);
});
