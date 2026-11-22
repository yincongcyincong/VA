import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLogger, errorCode } from '../lib/logger.js';

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'va-log-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('logs are JSON lines under the VA launch directory', async t => {
  const directory = await temporary(t);
  const logger = createLogger(directory);
  logger.write('info', 'app.start', { platform: process.platform });
  logger.write('warn', 'doubao.bind_failed', { code: errorCode({ code: 'CLIENT_ROUTE', message: 'hidden message' }) });
  const path = join(directory, 'logs', 'va.log');
  const raw = await readFile(path, 'utf8');
  const records = raw.trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.equal(records[0].pid, process.pid);
  assert.equal(records[0].event, 'app.start');
  assert.ok(Number.isFinite(Date.parse(records[0].time)));
  assert.equal(records[1].code, 'CLIENT_ROUTE');
  assert.doesNotMatch(raw, /hidden message/);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o077, 0);
  assert.equal(errorCode({ code: 'potentially private data' }), 'INTERNAL_ERROR');
});

test('rotating the log retains one previous file', async t => {
  const directory = await temporary(t);
  const logger = createLogger(directory, { maxBytes: 145 });
  for (const event of ['first', 'second', 'third']) logger.write('info', event);
  const path = join(directory, 'logs', 'va.log');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).event, 'third');
  assert.equal(JSON.parse(await readFile(path + '.1', 'utf8')).event, 'second');
});

test('unwritable log locations do not block runtime work', async t => {
  const directory = await temporary(t);
  const obstruction = join(directory, 'logs');
  await writeFile(obstruction, 'file in the way');
  const errors = [];
  const logger = createLogger(directory, { onError: error => errors.push(error) });
  logger.write('info', 'one');
  logger.write('info', 'two');
  assert.equal(errors.length, 1);
  await rm(obstruction);
  logger.write('info', 'recovered');
  assert.equal(JSON.parse(await readFile(join(obstruction, 'va.log'), 'utf8')).event, 'recovered');
});
