import fs from 'node:fs/promises';
import path from 'node:path';

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(root, target) {
  const relative = path.relative(pathKey(root), pathKey(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function removeManagedProjectWorkspace({ managedRoot, project }) {
  if (project?.workspaceKind !== 'managed') return false;
  if (typeof managedRoot !== 'string' || !path.isAbsolute(managedRoot)) {
    throw new Error('受管理研究工作区根目录无效。');
  }
  if (typeof project.workspacePath !== 'string' || !path.isAbsolute(project.workspacePath)) {
    throw new Error('受管理研究工作区路径无效。');
  }

  const root = path.resolve(managedRoot);
  const target = path.resolve(project.workspacePath);
  if (target === root || !isWithin(root, target)) {
    throw new Error('拒绝删除受管理目录之外的研究工作区。');
  }

  let realRoot;
  let realTarget;
  try {
    [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (realTarget === realRoot || !isWithin(realRoot, realTarget)) {
    throw new Error('拒绝删除受管理目录之外的研究工作区。');
  }
  await fs.rm(realTarget, { recursive: true, force: true });
  return true;
}
