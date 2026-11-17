import fs from 'node:fs/promises';
import path from 'node:path';

function isWithin(workspace, target) {
  const relative = path.relative(workspace, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

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
