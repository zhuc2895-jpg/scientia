import fs from 'node:fs/promises';
import path from 'node:path';

function safeIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label}无效。`);
  }
  return value;
}

export async function readRunManifest({ workspace, conversationId, runId }) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('研究工作区无效。');
  const safeConversationId = safeIdentifier(conversationId, '会话 ID');
  const safeRunId = safeIdentifier(runId, '运行 ID');
  const relativePath = path.posix.join('.science', 'runs', safeConversationId, safeRunId, 'manifest.json');
  const manifestPath = path.join(workspace, ...relativePath.split('/'));
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.runId !== safeRunId || manifest.conversationId !== safeConversationId) {
    throw new Error('Run Manifest 与当前会话或运行不匹配。');
  }
  return { manifest, manifestPath: relativePath };
}
