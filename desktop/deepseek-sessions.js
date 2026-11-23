import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sessionPattern = /^session-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export const deepSeekSessionId = id => typeof id === 'string' && sessionPattern.test(id);
export const deepSeekHome = (env = process.env) => env.DSH_HOME || join(homedir(), '.dsh');

async function storage(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return;
    throw error;
  }
}

export async function deepSeekArchives(env) {
  const index = await storage(join(deepSeekHome(env), 'storages', 'workspace.json'));
  const ids = index?.global?.archivedSessionIds;
  return new Set(Array.isArray(ids) ? ids.filter(deepSeekSessionId).map(id => id.toLowerCase()) : []);
}

export async function deepSeekCachedTitle(id, env) {
  if (!deepSeekSessionId(id)) return;
  const entry = await storage(join(deepSeekHome(env), 'storages', 'session_projcache', 'sessions', id.toLowerCase() + '.json'));
  return entry?.record?.rows?.title?.val;
}
