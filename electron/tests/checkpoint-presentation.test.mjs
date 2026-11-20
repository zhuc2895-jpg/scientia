import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceCheckpointPrompt } from '../../app/checkpoint-presentation.js';

test('source Checkpoint recovery presents the complete decision contract', () => {
  const prompt = sourceCheckpointPrompt({
    type: 'source-removal',
    metadata: {
      trigger: 'The user requested removal.',
      risk: 'Evidence Freeze will be revoked.',
      options: ['Remove the Source Record', 'Cancel and keep it'],
      recommendation: 'Keep the record unless it is wrong.',
      estimatedTimeCost: 'Local metadata update; seconds.',
    },
  });
  for (const text of [
    'The user requested removal.',
    'Evidence Freeze will be revoked.',
    'Remove the Source Record',
    'Cancel and keep it',
    'Keep the record unless it is wrong.',
    'Local metadata update; seconds.',
  ]) {
    assert.match(prompt, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
