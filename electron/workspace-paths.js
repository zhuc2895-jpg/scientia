import fs from 'node:fs/promises';
import path from 'node:path';

import { isWithin } from './path-boundary.js';

export async function resolveWorkspaceEntry(workspace, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error('文件路径无效。');
  }
  const workspaceRoot = path.resolve(workspace);
  const lexicalTarget = path.resolve(workspaceRoot, relativePath);
  if (!isWithin(workspaceRoot, lexicalTarget)) throw new Error('文件不在当前研究目录中。');

  const [realWorkspace, realTarget] = await Promise.all([
    fs.realpath(workspaceRoot),
    fs.realpath(lexicalTarget),
  ]);
  if (!isWithin(realWorkspace, realTarget)) throw new Error('文件不在当前研究目录中。');
  return realTarget;
}
