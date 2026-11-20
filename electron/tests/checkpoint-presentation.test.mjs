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
      locator: 'line:3',
      quote: 'The intervention reduced error.',
      claim: 'The intervention reduced measurement error.',
    },
  });
  for (const text of [
    'The user requested removal.',
    'Evidence Freeze will be revoked.',
    'Remove the Source Record',
    'Cancel and keep it',
    'Keep the record unless it is wrong.',
    'Local metadata update; seconds.',
    'line:3',
    'The intervention reduced error.',
    'The intervention reduced measurement error.',
  ]) {
    assert.match(prompt, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
