import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isWithin } from './path-boundary.js';

function safeSegment(value) {
  return String(value || 'source')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'source';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function containedRealPath(workspacePath, relativePath) {
  const absolute = path.resolve(workspacePath, relativePath);
  if (!isWithin(workspacePath, absolute)) throw new Error('Source locator 不在当前 Research Workspace 中。');
  const [realWorkspace, realTarget] = await Promise.all([fs.realpath(workspacePath), fs.realpath(absolute)]);
  if (!isWithin(realWorkspace, realTarget)) throw new Error('Source locator 指向当前 Research Workspace 之外。');
  return realTarget;
}

export async function stageSourceRevision({
  workspacePath,
  sourceId,
  bytes,
  idFactory = randomUUID,
} = {}) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) {
    throw new Error('Research Workspace 路径无效。');
  }
  if (!Buffer.isBuffer(bytes)) throw new Error('Source revision 内容无效。');
  const observedContentHash = sha256(bytes);
  const directory = path.join(workspacePath, '.science', 'source-revisions');
  await fs.mkdir(directory, { recursive: true });
  const filename = `${safeSegment(sourceId)}-${safeSegment(idFactory())}-${observedContentHash.slice(0, 16)}.revision`;
  const absolute = path.join(directory, filename);
  await fs.writeFile(absolute, bytes, { flag: 'wx' });
  return {
    observedContentHash,
    stagedLocator: path.relative(workspacePath, absolute).split(path.sep).join('/'),
  };
}

export async function installSourceRevision({
  workspacePath,
  source,
  stagedLocator,
  expectedContentHash,
} = {}) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) {
    throw new Error('Research Workspace 路径无效。');
  }
  if (!source || typeof source.localLocator !== 'string' || !source.localLocator.trim()) {
    throw new Error('Source Record 缺少本地定位。');
  }
  if (typeof stagedLocator !== 'string' || !stagedLocator.trim()) {
    throw new Error('Source revision staging locator 无效。');
  }
  const normalizedHash = String(expectedContentHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) throw new Error('Source revision content hash 无效。');
  const stagedPath = await containedRealPath(workspacePath, stagedLocator);
  const targetLocator = source.localLocator.split('#')[0];
  const targetPath = path.resolve(workspacePath, targetLocator);
  if (!isWithin(workspacePath, targetPath)) throw new Error('Source locator 不在当前 Research Workspace 中。');
  const targetStat = await fs.lstat(targetPath);
  if (targetStat.isSymbolicLink()) throw new Error('Source target 不能是符号链接。');
  const realWorkspace = await fs.realpath(workspacePath);
  const realTarget = await fs.realpath(targetPath);
  if (!isWithin(realWorkspace, realTarget)) throw new Error('Source target 指向当前 Research Workspace 之外。');
  const bytes = await fs.readFile(stagedPath);
  if (sha256(bytes) !== normalizedHash) throw new Error('Staged Source revision 已变化，请重新刷新。');
  const temporaryPath = `${targetPath}.${randomUUID()}.installing`;
  await fs.writeFile(temporaryPath, bytes, { flag: 'wx' });
  try {
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
  return { contentHash: normalizedHash };
}

export async function removeStagedSourceRevision({ workspacePath, stagedLocator } = {}) {
  if (typeof stagedLocator !== 'string' || !stagedLocator.trim()) return;
  try {
    const stagedPath = await containedRealPath(workspacePath, stagedLocator);
    await fs.rm(stagedPath, { force: true });
  } catch {
    // Staging cleanup is best-effort after the accepted revision is durable.
  }
}
