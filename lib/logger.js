import { appendFileSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function errorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : 'INTERNAL_ERROR';
}

export function createLogger(launchDirectory, {
  maxBytes = 2 * 1024 * 1024,
  onError = error => console.warn('VA 无法写入 logs/va.log（' + errorCode(error) + '）。'),
} = {}) {
  const directory = join(launchDirectory, 'logs');
  const path = join(directory, 'va.log');
  let warned = false;

  function write(level, event, fields = {}) {
    try {
      // Keep request bodies and error messages out of fields. Callers supply diagnostic metadata only.
      const line = JSON.stringify({ time: new Date().toISOString(), level, event, pid: process.pid, ...fields }) + '\n';
      mkdirSync(directory, { mode: 0o700, recursive: true });
      if (!lstatSync(directory).isDirectory()) throw new Error('Invalid log directory');
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (current && !current.isFile()) throw new Error('Invalid log file');
      if (current?.size && current.size + Buffer.byteLength(line) > maxBytes) renameSync(path, path + '.1');
      appendFileSync(path, line, { mode: 0o600 });
      warned = false;
    } catch (error) {
      if (!warned) {
        warned = true;
        onError(error);
      }
    }
  }

  return { write };
}
