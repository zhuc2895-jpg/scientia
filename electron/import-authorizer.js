import { randomUUID } from 'node:crypto';
import path from 'node:path';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_IMPORT_FILES = 20;

export function createImportAuthorizer({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  const grants = new Map();

  function purgeExpired() {
    const currentTime = now();
    for (const [token, grant] of grants) {
      if (grant.expiresAt <= currentTime) grants.delete(token);
    }
  }

  function authorize(paths) {
    if (!Array.isArray(paths) || paths.length === 0) return [];
    if (paths.length > MAX_IMPORT_FILES) throw new Error('一次最多导入 20 个文件。');
    if (paths.some((source) => typeof source !== 'string' || !path.isAbsolute(source))) {
      throw new Error('导入文件路径无效。');
    }
    purgeExpired();
    const expiresAt = now() + ttlMs;
    return paths.map((source) => {
      const token = randomUUID();
      grants.set(token, { path: source, expiresAt });
      return token;
    });
  }

  function consume(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return [];
    if (tokens.length > MAX_IMPORT_FILES) throw new Error('一次最多导入 20 个文件。');
    purgeExpired();
    const uniqueTokens = [...new Set(tokens)];
    const selected = uniqueTokens.map((token) => grants.get(token));
    if (selected.some((grant) => !grant)) throw new Error('导入授权无效或已过期，请重新选择文件。');
    for (const token of uniqueTokens) grants.delete(token);
    return selected.map((grant) => grant.path);
  }

  return { authorize, consume };
}
