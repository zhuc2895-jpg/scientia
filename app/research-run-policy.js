const POLICY_RANK = { standard: 0, sensitive: 1, 'local-only': 2 };

function strictestPolicy(current, approved) {
  const valid = [current?.dataPolicy, approved?.dataPolicy].filter((policy) => policy in POLICY_RANK);
  if (!valid.length) return 'standard';
  return valid.reduce((selected, policy) => (
    POLICY_RANK[policy] > POLICY_RANK[selected] ? policy : selected
  ));
}

export function evaluateResearchRunPolicy({ stageKey = null, charter, sensitiveTransmissionConfirmed = false } = {}) {
  const current = charter?.current || null;
  const approved = charter?.approved || null;
  const policy = strictestPolicy(current, approved);
  if (stageKey && stageKey !== 'scoping' && !approved) {
    return {
      allowed: false,
      code: 'approved-charter-required',
      policy,
      requiresConfirmation: false,
      approvedCharter: null,
      message: 'A Research Run after Scoping requires an approved Research Charter.',
    };
  }
  if (policy === 'local-only') {
    return {
      allowed: false,
      code: 'local-only',
      policy,
      requiresConfirmation: false,
      message: 'The approved Research Charter requires local-only processing; external model and search calls are disabled.',
    };
  }
  if (policy === 'sensitive' && !sensitiveTransmissionConfirmed) {
    return {
      allowed: false,
      code: 'sensitive-confirmation-required',
      policy,
      requiresConfirmation: true,
      message: 'The Research Charter requires explicit confirmation before sensitive data leaves the machine.',
    };
  }
  return { allowed: true, code: 'allowed', policy, requiresConfirmation: false, approvedCharter: approved };
}
