export function normalizeConversation(value, { now = new Date().toISOString() } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('会话数据无效。');
  }
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200) {
    throw new Error('会话 ID 无效。');
  }
  return {
    ...value,
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : '新的研究',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
    messages: Array.isArray(value.messages) ? value.messages.map((message) => ({ ...message })) : [],
    activities: Array.isArray(value.activities) ? value.activities.map((activity) => ({ ...activity })) : [],
    evidenceMode: value.evidenceMode !== false,
    researchMode: typeof value.researchMode === 'string' ? value.researchMode : 'auto',
    ...(value.activeRun && typeof value.activeRun === 'object'
      ? { activeRun: { ...value.activeRun } }
      : {}),
  };
}

export function tryNormalizeConversation(value) {
  try {
    return normalizeConversation(value);
  } catch {
    return null;
  }
}

export function conversationSnapshot(conversation) {
  return normalizeConversation(conversation);
}

export function recoverInterruptedRuns(conversations, { recoveredAt = new Date().toISOString() } = {}) {
  const conversationIds = [];
  const recoveredConversations = (Array.isArray(conversations) ? conversations : []).map((conversation) => {
    const recovered = normalizeConversation(conversation);
    const runningMessages = recovered.messages.filter((message) => message.status === 'running');
    const activeRunIsRunning = recovered.activeRun?.status === 'running' && recovered.activeRun?.recoveryStatus !== 'needs-review';
    if (!runningMessages.length && !activeRunIsRunning) return recovered;

    conversationIds.push(recovered.id);
    const recoveredRun = recovered.activeRun || {};
    const firstMessage = runningMessages[0];
    recovered.messages = recovered.messages.map((message) => (
      message.status === 'running'
        ? { ...message, status: 'needs-review', statusText: '应用重启，运行已中断，需要复核后可继续' }
        : message
    ));
    recovered.activeRun = {
      ...recoveredRun,
      runId: recoveredRun.runId || firstMessage.runId || null,
      assistantId: recoveredRun.assistantId || firstMessage?.id || null,
      startedAt: recoveredRun.startedAt || firstMessage?.createdAt || null,
      status: recoveredRun.status || 'running',
      recoveryStatus: 'needs-review',
      recoveredAt,
    };
    recovered.activities.push({
      id: `recovery-${recovered.id}-${recoveredAt}`,
      label: '应用重启，研究运行需要复核后可继续',
      status: 'done',
      time: recoveredAt,
    });
    recovered.updatedAt = recoveredAt;
    return recovered;
  });

  return {
    conversations: recoveredConversations,
    changed: conversationIds.length > 0,
    conversationIds,
  };
}

export function reconcileRunManifest(conversation, {
  manifest,
  manifestPath,
  reconciledAt = new Date().toISOString(),
} = {}) {
  const reconciled = normalizeConversation(conversation);
  if (!manifest || typeof manifest !== 'object') throw new Error('Run Manifest 无效。');
  const run = reconciled.activeRun || {};
  const messageId = run.assistantId || reconciled.messages.find((message) => message.status === 'needs-review')?.id;
  const message = reconciled.messages.find((item) => item.id === messageId);
  const terminal = ['completed', 'failed', 'cancelled'].includes(manifest.status);

  if (terminal) {
    if (message) {
      if (manifest.status === 'completed') {
        message.status = 'done';
        message.statusText = '运行已完成';
        message.content = typeof manifest.result === 'string' ? manifest.result : message.content;
        message.artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
        message.quality = manifest.quality || null;
        message.usage = manifest.usage || null;
        message.completedAt = manifest.finishedAt || reconciledAt;
        message.sessionId = manifest.sessionId || message.sessionId;
      } else if (manifest.status === 'failed') {
        message.status = 'error';
        message.error = manifest.error || '研究运行失败。';
      } else {
        message.status = 'cancelled';
        message.content = message.content || '研究任务已停止。';
      }
    }
    reconciled.lastRecoveredRun = { ...manifest, manifestPath, reconciledAt };
    reconciled.lastResearchRun = { ...manifest, manifestPath, reconciledAt };
    reconciled.activeRun = null;
  } else if (reconciled.activeRun) {
    reconciled.activeRun = {
      ...reconciled.activeRun,
      status: manifest.status || reconciled.activeRun.status || 'running',
      recoveryStatus: 'needs-review',
      manifest,
      manifestPath,
      reconciledAt,
    };
  }
  reconciled.updatedAt = reconciledAt;
  return reconciled;
}
