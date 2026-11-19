export const RESEARCH_CHARTER_FIELDS = Object.freeze([
  { key: 'question', label: '研究问题', maxLength: 2000 },
  { key: 'contribution', label: '预期贡献', maxLength: 2000 },
  { key: 'scope', label: '研究范围', maxLength: 3000 },
  { key: 'methodConstraints', label: '方法约束', maxLength: 3000 },
  { key: 'successCriteria', label: '成功标准', maxLength: 3000 },
  { key: 'paperType', label: '论文类型', maxLength: 120 },
  { key: 'citationStyle', label: '引用格式', maxLength: 120 },
  { key: 'dataPolicy', label: '数据处理政策', maxLength: 40 },
]);

export const DATA_POLICIES = Object.freeze(['standard', 'sensitive', 'local-only']);
const FIELD_KEYS = RESEARCH_CHARTER_FIELDS.map((field) => field.key);
const FIELD_CONFIG = new Map(RESEARCH_CHARTER_FIELDS.map((field) => [field.key, field]));
const REVISION_STATUSES = new Set(['draft', 'approved']);
const REVISION_ORIGINS = new Set(['agent', 'user']);

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeFields(value, { strict = false } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fields = {};
  for (const key of FIELD_KEYS) {
    const config = FIELD_CONFIG.get(key);
    const raw = typeof source[key] === 'string' ? source[key].trim() : '';
    if (strict && !raw) throw new Error(`Research Charter 的${config.label}不能为空。`);
    if (raw.length > config.maxLength) throw new Error(`Research Charter 的${config.label}不能超过 ${config.maxLength} 个字符。`);
    fields[key] = raw;
  }
  if (!DATA_POLICIES.includes(fields.dataPolicy)) {
    throw new Error('Research Charter 的数据处理政策无效。');
  }
  return fields;
}

function normalizeRevision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const version = Number(value.version);
  if (!Number.isInteger(version) || version < 1) return null;
  if (!REVISION_STATUSES.has(value.status)) return null;
  let fields;
  try {
    fields = normalizeFields(value, { strict: true });
  } catch {
    return null;
  }
  const createdAt = normalizeTimestamp(value.createdAt);
  const updatedAt = normalizeTimestamp(value.updatedAt) || createdAt;
  if (!createdAt || !updatedAt) return null;
  const revisionOrigin = REVISION_ORIGINS.has(value.revisionOrigin)
    ? value.revisionOrigin
    : REVISION_ORIGINS.has(value.source) ? value.source : 'user';
  const approvedAt = value.status === 'approved' ? normalizeTimestamp(value.approvedAt) || updatedAt : null;
  const supersedes = Number.isInteger(Number(value.supersedes)) && Number(value.supersedes) > 0
    ? Number(value.supersedes)
    : null;
  return {
    ...fields,
    version,
    status: value.status,
    revisionOrigin,
    createdAt,
    updatedAt,
    approvedAt,
    approvedBy: value.status === 'approved' ? 'user' : null,
    supersedes,
    generatedByRunId: typeof value.generatedByRunId === 'string' && value.generatedByRunId.trim()
      ? value.generatedByRunId.trim()
      : null,
    contentHash: typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/.test(value.contentHash)
      ? value.contentHash
      : null,
  };
}

export function createInitialResearchCharterState() {
  return {
    currentVersion: null,
    approvedVersion: null,
    revisions: [],
  };
}

export function normalizeResearchCharterState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawRevisions = Array.isArray(source.revisions) ? source.revisions : [];
  const byVersion = new Map();
  for (const raw of rawRevisions) {
    const revision = normalizeRevision(raw);
    if (revision && !byVersion.has(revision.version)) byVersion.set(revision.version, revision);
  }
  const revisions = [...byVersion.values()].sort((a, b) => a.version - b.version);
  if (!revisions.length) return createInitialResearchCharterState();

  const requestedCurrent = Number(source.currentVersion);
  const currentVersion = revisions.some((revision) => revision.version === requestedCurrent)
    ? requestedCurrent
    : revisions[revisions.length - 1].version;
  const requestedApproved = Number(source.approvedVersion);
  const approvedRevisions = revisions.filter((revision) => revision.status === 'approved');
  const approvedVersion = approvedRevisions.some((revision) => revision.version === requestedApproved)
    ? requestedApproved
    : approvedRevisions[approvedRevisions.length - 1]?.version || null;
  return { currentVersion, approvedVersion, revisions };
}

export function currentResearchCharter(state) {
  const normalized = normalizeResearchCharterState(state);
  return normalized.revisions.find((revision) => revision.version === normalized.currentVersion) || null;
}

export function currentApprovedResearchCharter(state) {
  const normalized = normalizeResearchCharterState(state);
  const current = normalized.revisions.find((revision) => revision.version === normalized.currentVersion);
  if (!current || current.status !== 'approved') return null;
  return current;
}

export function charterNeedsReapproval(state) {
  const normalized = normalizeResearchCharterState(state);
  const current = currentResearchCharter(normalized);
  return Boolean(current && current.status === 'draft' && normalized.approvedVersion !== null);
}

export function saveResearchCharterDraft(state, value, {
  revisionOrigin = 'user',
  updatedAt = new Date().toISOString(),
  generatedByRunId = null,
} = {}) {
  const normalized = normalizeResearchCharterState(state);
  const fields = normalizeFields(value, { strict: true });
  const timestamp = normalizeTimestamp(updatedAt) || new Date().toISOString();
  const normalizedOrigin = REVISION_ORIGINS.has(revisionOrigin) ? revisionOrigin : 'user';
  const normalizedRunId = typeof generatedByRunId === 'string' && generatedByRunId.trim()
    ? generatedByRunId.trim()
    : null;
  const current = currentResearchCharter(normalized);

  if (!current) {
    const revision = {
      ...fields,
      version: 1,
      status: 'draft',
      revisionOrigin: normalizedOrigin,
      createdAt: timestamp,
      updatedAt: timestamp,
      approvedAt: null,
      approvedBy: null,
      supersedes: null,
      generatedByRunId: normalizedRunId,
      contentHash: null,
    };
    return { currentVersion: 1, approvedVersion: null, revisions: [revision] };
  }

  const unchanged = FIELD_KEYS.every((key) => current[key] === fields[key]);
  const agentTakesOverUserDraft = normalizedOrigin === 'agent' && current.revisionOrigin === 'user';
  if (unchanged && !agentTakesOverUserDraft) return normalized;
  const revision = {
    ...fields,
    version: current.version + 1,
    status: 'draft',
    revisionOrigin: normalizedOrigin,
    createdAt: timestamp,
    updatedAt: timestamp,
    approvedAt: null,
    approvedBy: null,
    supersedes: current.version,
    generatedByRunId: normalizedRunId || current.generatedByRunId || null,
    contentHash: null,
  };
  return {
    currentVersion: revision.version,
    approvedVersion: normalized.approvedVersion,
    revisions: [...normalized.revisions, revision],
  };
}

export function approveResearchCharter(state, { approvedAt = new Date().toISOString() } = {}) {
  const normalized = normalizeResearchCharterState(state);
  const current = currentResearchCharter(normalized);
  if (!current) throw new Error('请先起草 Research Charter。');
  if (current.status === 'approved') return normalized;
  const timestamp = normalizeTimestamp(approvedAt) || new Date().toISOString();
  const approved = {
    ...current,
    version: current.version + 1,
    status: 'approved',
    createdAt: timestamp,
    updatedAt: timestamp,
    approvedAt: timestamp,
    approvedBy: 'user',
    supersedes: current.version,
    contentHash: null,
  };
  return {
    currentVersion: approved.version,
    approvedVersion: approved.version,
    revisions: [...normalized.revisions, approved],
  };
}

export function setCurrentResearchCharterContentHash(state, contentHash) {
  const normalized = normalizeResearchCharterState(state);
  const current = currentResearchCharter(normalized);
  if (!current) throw new Error('请先起草 Research Charter。');
  if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error('Research Charter 内容哈希无效。');
  }
  return {
    ...normalized,
    revisions: normalized.revisions.map((revision) => (
      revision.version === current.version ? { ...revision, contentHash } : revision
    )),
  };
}


export function researchCharterFieldsEqual(left, right) {
  const leftFields = normalizeFields(left, { strict: true });
  const rightFields = normalizeFields(right, { strict: true });
  return FIELD_KEYS.every((key) => leftFields[key] === rightFields[key]);
}

export function researchCharterContentString(value) {
  const fields = normalizeFields(value, { strict: true });
  return JSON.stringify({
    version: Number(value?.version) || 1,
    ...fields,
    supersedes: Number(value?.supersedes) || null,
    generatedByRunId: typeof value?.generatedByRunId === 'string' && value.generatedByRunId.trim()
      ? value.generatedByRunId.trim()
      : null,
  });
}
