import fs from 'node:fs/promises';
import path from 'node:path';

import { isWithin } from './path-boundary.js';

export async function removeManagedProjectWorkspace({ managedRoot, project, protectedPaths = [] }) {
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
  for (const protectedPath of protectedPaths) {
    if (typeof protectedPath === 'string' && path.isAbsolute(protectedPath) && isWithin(target, protectedPath)) {
      throw new Error('受管理目录内仍包含其他 Research Workspace，拒绝递归删除。');
    }
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
  for (const protectedPath of protectedPaths) {
    if (typeof protectedPath !== 'string' || !path.isAbsolute(protectedPath)) continue;
    try {
      const realProtected = await fs.realpath(protectedPath);
      if (isWithin(realTarget, realProtected)) {
        throw new Error('受管理目录内仍包含其他 Research Workspace，拒绝递归删除。');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await fs.rm(realTarget, { recursive: true, force: true });
  return true;
}
