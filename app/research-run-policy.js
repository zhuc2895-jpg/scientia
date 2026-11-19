export const DATA_PROCESSING_POLICIES = Object.freeze(['standard', 'sensitive', 'local-only']);

export function evaluateResearchRunPolicy({ stageKey = null, charter, sensitiveTransmissionConfirmed = false } = {}) {
  const current = charter?.current || null;
  const approved = charter?.approved || null;
  const effective = current || approved;
  const policy = DATA_PROCESSING_POLICIES.includes(effective?.dataPolicy)
    ? effective.dataPolicy
    : 'standard';

  if (stageKey && stageKey !== 'scoping' && !approved) {
    return {
      allowed: false,
      code: 'approved-charter-required',
      policy,
      requiresConfirmation: false,
      approvedCharter: null,
      charterDraftMode: false,
      message: '进入 Evidence 后，Research Run 必须引用当前 approved Research Charter。',
    };
  }
  if (policy === 'local-only') {
    return {
      allowed: false,
      code: 'local-only',
      policy,
      requiresConfirmation: false,
      approvedCharter: approved,
      charterDraftMode: stageKey === 'scoping' && !approved,
      message: '当前 Research Charter 使用 local-only Data Processing Policy，首版禁止外部模型与检索调用。',
    };
  }
  if (policy === 'sensitive' && !sensitiveTransmissionConfirmed) {
    return {
      allowed: false,
      code: 'sensitive-confirmation-required',
      policy,
      requiresConfirmation: true,
      approvedCharter: approved,
      charterDraftMode: stageKey === 'scoping' && !approved,
      message: '当前 Research Charter 使用 sensitive Data Processing Policy，外部传输前必须获得用户确认。',
    };
  }
  return {
    allowed: true,
    code: 'allowed',
    policy,
    requiresConfirmation: false,
    approvedCharter: approved,
    charterDraftMode: stageKey === 'scoping' && !approved,
    message: '',
  };
}
