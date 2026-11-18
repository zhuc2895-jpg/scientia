import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function createConfigStore({ filePath, defaults = () => ({}) }) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('配置文件路径无效。');

  let writeQueue = Promise.resolve();

  function queue(operation) {
    const queued = writeQueue.then(operation, operation);
    writeQueue = queued.catch(() => {});
    return queued;
  }

  function invalidConfigError(message, cause) {
    const error = new Error(message, { cause });
    error.code = 'CONFIG_INVALID';
    return error;
  }

  async function read() {
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return defaults();
      throw new Error(`无法读取配置文件：${error?.message || error}`, { cause: error });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw invalidConfigError(`配置文件格式无效：${error?.message || error}`, error);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidConfigError('配置文件格式无效：内容必须是 JSON 对象。');
    }
    return { ...defaults(), ...parsed };
  }

  async function writeValue(value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(temp, filePath);
          return;
        } catch (error) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
        }
      }
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  function runUpdate(mutator, { resetInvalid = false } = {}) {
    return queue(async () => {
      let current;
      let reset = false;
      try {
        current = await read();
      } catch (error) {
        if (!resetInvalid || error?.code !== 'CONFIG_INVALID') throw error;
        current = defaults();
        reset = true;
      }
      const value = await mutator(current);
      if (reset || value !== current) await writeValue(value);
      return value;
    });
  }

  function update(mutator) {
    return runUpdate(mutator);
  }

  function updateOrReset(mutator) {
    return runUpdate(mutator, { resetInvalid: true });
  }

  return { read, update, updateOrReset };
}
