function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`Checkpoint 缺少 ${label}。`);
  return text;
}

export function sourceCheckpointPrompt(checkpoint = {}) {
  const metadata = checkpoint.metadata && typeof checkpoint.metadata === 'object' ? checkpoint.metadata : {};
  const options = Array.isArray(metadata.options) ? metadata.options.map((option) => String(option || '').trim()).filter(Boolean) : [];
  if (options.length < 2) throw new Error('Checkpoint 缺少可比较的决策选项。');
  const evidence = metadata.locator || metadata.quote || metadata.claim
    ? `Evidence: locator=${requiredText(metadata.locator, 'locator')}; quote=${requiredText(metadata.quote, 'quote')}; claim=${requiredText(metadata.claim, 'claim')}`
    : null;
  return [
    `Trigger: ${requiredText(metadata.trigger, 'trigger')}`,
    `Risk: ${requiredText(metadata.risk, 'risk')}`,
    `Options: ${options.join(' / ')}`,
    `Recommendation: ${requiredText(metadata.recommendation, 'recommendation')}`,
    `Estimated time/cost: ${requiredText(metadata.estimatedTimeCost, 'estimated time/cost')}`,
    ...(evidence ? [evidence] : []),
    '',
    'Approve this Checkpoint decision now?',
  ].join('\n');
}
