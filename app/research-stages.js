export const RESEARCH_STAGES = Object.freeze([
  {
    key: 'scoping',
    englishLabel: 'Scoping',
    label: '界定',
    description: '确定研究问题、边界、方法约束与成功标准。',
  },
  {
    key: 'evidence',
    englishLabel: 'Evidence',
    label: '证据',
    description: '建立 Source Library、Active Source Set 与 Evidence Ledger。',
  },
  {
    key: 'inquiry',
    englishLabel: 'Inquiry',
    label: '探究',
    description: '开展文献、数据、计算或实验探究并记录研究轨迹。',
  },
  {
    key: 'synthesis',
    englishLabel: 'Synthesis',
    label: '综合',
    description: '综合证据、处理冲突并收敛可辩护的研究主张。',
  },
  {
    key: 'manuscript',
    englishLabel: 'Manuscript',
    label: '写作',
    description: '组织稿件、图表、引用与可复现的论文源文件。',
  },
  {
    key: 'release',
    englishLabel: 'Release',
    label: '发布',
    description: '执行 Release Audit，形成可核验的 Paper Package。',
  },
]);

const STAGE_KEYS = new Set(RESEARCH_STAGES.map((stage) => stage.key));
const TERMINAL_STATUSES = new Set(['completed', 'not_applicable']);
const MAX_REASON_LENGTH = 500;

function stageIndex(key) {
  return RESEARCH_STAGES.findIndex((stage) => stage.key === key);
}

function normalizeStageKey(value) {
  if (typeof value !== 'string' || !STAGE_KEYS.has(value)) {
    throw new Error('Research 阶段无效。');
  }
  return value;
}

function normalizeReason(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('将 Research Stage 标记为不适用时必须记录原因。');
  }
  const reason = value.trim();
  if (reason.length > MAX_REASON_LENGTH) {
    throw new Error(`Research Stage 不适用原因不能超过 ${MAX_REASON_LENGTH} 个字符。`);
  }
  return reason;
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const updatedAt = normalizeTimestamp(record.updatedAt);
  if (record.status === 'completed') {
    return {
      status: 'completed',
      updatedAt,
      completedAt: normalizeTimestamp(record.completedAt) || updatedAt,
      notApplicableReason: null,
    };
  }
  if (record.status === 'not_applicable') {
    let reason = null;
    try {
      reason = normalizeReason(record.notApplicableReason);
    } catch {
      return null;
    }
    return {
      status: 'not_applicable',
      updatedAt,
      completedAt: null,
      notApplicableReason: reason,
    };
  }
  return null;
}

function firstUnresolvedStageKey(stages) {
  return RESEARCH_STAGES.find((stage) => !TERMINAL_STATUSES.has(stages[stage.key]?.status))?.key || null;
}

function nextUnresolvedStageKey(stages, fromIndex) {
  return RESEARCH_STAGES.slice(fromIndex + 1)
    .find((stage) => !TERMINAL_STATUSES.has(stages[stage.key]?.status))?.key || null;
}

export function createInitialResearchStageState() {
  return {
    currentStageKey: 'scoping',
    stages: {},
  };
}

export function normalizeResearchStageState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceStages = source.stages && typeof source.stages === 'object' && !Array.isArray(source.stages)
    ? source.stages
    : {};
  const stages = {};
  for (const stage of RESEARCH_STAGES) {
    const record = normalizeRecord(sourceStages[stage.key]);
    if (record) stages[stage.key] = record;
  }

  let currentStageKey = typeof source.currentStageKey === 'string' && STAGE_KEYS.has(source.currentStageKey)
    ? source.currentStageKey
    : firstUnresolvedStageKey(stages);
  if (currentStageKey && stages[currentStageKey]?.status === 'not_applicable') {
    currentStageKey = firstUnresolvedStageKey(stages);
  }
  if (!currentStageKey) currentStageKey = null;

  return { currentStageKey, stages };
}

function advanceAfterStage(state, completedIndex) {
  return {
    ...state,
    currentStageKey: nextUnresolvedStageKey(state.stages, completedIndex),
  };
}

export function completeResearchStage(state, stageKey, { completedAt = new Date().toISOString() } = {}) {
  const key = normalizeStageKey(stageKey);
  const normalized = normalizeResearchStageState(state);
  if (normalized.currentStageKey !== key) {
    const current = RESEARCH_STAGES.find((stage) => stage.key === normalized.currentStageKey);
    throw new Error(`只能推进当前阶段；当前阶段是 ${current?.englishLabel || '无'}。`);
  }
  const updatedAt = normalizeTimestamp(completedAt) || new Date().toISOString();
  const updated = {
    ...normalized,
    stages: {
      ...normalized.stages,
      [key]: {
        status: 'completed',
        updatedAt,
        completedAt: updatedAt,
        notApplicableReason: null,
      },
    },
  };
  return advanceAfterStage(updated, stageIndex(key));
}

export function markResearchStageNotApplicable(state, stageKey, reason, { markedAt = new Date().toISOString() } = {}) {
  const key = normalizeStageKey(stageKey);
  const normalizedReason = normalizeReason(reason);
  const normalized = normalizeResearchStageState(state);
  if (normalized.currentStageKey !== key) {
    const current = RESEARCH_STAGES.find((stage) => stage.key === normalized.currentStageKey);
    throw new Error(`只能跳过当前阶段；当前阶段是 ${current?.englishLabel || '无'}。`);
  }
  if (normalized.stages[key]?.status === 'completed') {
    throw new Error('已完成阶段不能标记为不适用。');
  }
  const updatedAt = normalizeTimestamp(markedAt) || new Date().toISOString();
  const updated = {
    ...normalized,
    stages: {
      ...normalized.stages,
      [key]: {
        status: 'not_applicable',
        updatedAt,
        completedAt: null,
        notApplicableReason: normalizedReason,
      },
    },
  };
  return advanceAfterStage(updated, stageIndex(key));
}

export function reopenResearchStage(state, stageKey, { reopenedAt = new Date().toISOString() } = {}) {
  const key = normalizeStageKey(stageKey);
  const normalized = normalizeResearchStageState(state);
  if (normalized.stages[key]?.status !== 'completed') {
    throw new Error('只有已完成阶段可以重新进入。');
  }
  return {
    ...normalized,
    currentStageKey: key,
    stages: {
      ...normalized.stages,
      [key]: {
        ...normalized.stages[key],
        updatedAt: normalizeTimestamp(reopenedAt) || new Date().toISOString(),
      },
    },
  };
}

export function buildResearchStageGraph(value) {
  const state = normalizeResearchStageState(value);
  const currentIndex = stageIndex(state.currentStageKey);
  const currentStageDefinition = RESEARCH_STAGES[currentIndex] || null;
  const stages = RESEARCH_STAGES.map((definition, index) => {
    const record = state.stages[definition.key] || null;
    const isCurrent = definition.key === state.currentStageKey;
    const isCompleted = record?.status === 'completed';
    const isNotApplicable = record?.status === 'not_applicable';
    const status = isCurrent ? 'current' : isCompleted ? 'completed' : isNotApplicable ? 'not_applicable' : 'pending';
    let lockReason = '';
    if (status === 'pending') {
      if (currentStageDefinition) {
        lockReason = index > currentIndex
          ? `需先完成或标记不适用 ${currentStageDefinition.englishLabel}。`
          : `需重新处理 ${definition.englishLabel} 的缺失完成记录。`;
      } else {
        lockReason = 'Research Stage 图中没有当前阶段，请先重新进入一个已完成阶段。';
      }
    }
    return {
      ...definition,
      index,
      status,
      isCurrent,
      isCompleted,
      isNotApplicable,
      isLocked: status === 'pending',
      lockReason,
      completedAt: record?.completedAt || null,
      notApplicableReason: record?.notApplicableReason || null,
    };
  });
  const currentStage = stages.find((stage) => stage.isCurrent) || null;
  const nextUnresolvedKey = currentIndex >= 0 ? nextUnresolvedStageKey(state.stages, currentIndex) : null;
  const nextUnresolved = RESEARCH_STAGES.find((stage) => stage.key === nextUnresolvedKey) || null;
  const nextAction = currentStage
    ? {
        type: 'advance',
        stageKey: currentStage.key,
        allowedActions: currentStage.isCompleted ? ['complete'] : ['complete', 'not_applicable'],
        label: currentStage.isCompleted ? `完成 ${currentStage.englishLabel} 复核` : `完成 ${currentStage.englishLabel}`,
        description: currentStage.isCompleted
          ? `该阶段保留完成记录。完成本次复核后，${nextUnresolved?.englishLabel || 'Research Stage 图'}将成为下一步。`
          : `完成 ${currentStage.englishLabel} 后，${nextUnresolved?.englishLabel || 'Research Stage 图'}将成为当前阶段；也可以记录原因并将此阶段标记为不适用。`,
      }
    : {
        type: 'complete',
        stageKey: null,
        allowedActions: [],
        label: '所有阶段已处理',
        description: '所有 Research Stage 均已完成或标记为不适用。',
      };

  return {
    currentStageKey: state.currentStageKey,
    currentStage,
    stages,
    nextAction,
    progress: {
      completed: stages.filter((stage) => stage.isCompleted).length,
      notApplicable: stages.filter((stage) => stage.isNotApplicable).length,
      pending: stages.filter((stage) => stage.status === 'pending').length,
      total: stages.length,
    },
  };
}
