import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';

export const name = 'va-desktop-role';
export const inject = ['systemPrompt'];

async function requestVA(command, signal) {
  const uid = process.getuid?.();
  if (uid === undefined || signal?.aborted) return;
  const folder = '/tmp/va-desktop-' + uid;
  const info = await lstat(folder).catch(() => undefined);
  if (!info?.isDirectory() || info.uid !== uid || (info.mode & 0o077)) return;

  return new Promise(resolve => {
    const socket = createConnection({ path: folder + '/control.sock', signal });
    let input = '';
    const finish = result => {
      resolve(result);
      socket.destroy();
    };
    const timer = setTimeout(finish, 750);
    socket.setEncoding('utf8');
    socket.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('error', () => finish());
    socket.once('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 1024 * 1024) return finish();
      const end = input.indexOf('\n');
      if (end === -1) return;
      try {
        const result = JSON.parse(input.slice(0, end));
        finish(result.ok ? result : undefined);
      } catch { finish(); }
    });
  });
}

export function apply(ctx) {
  ctx.systemPrompt.section({ name, order: 1000, text: '', interpolate: false });
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    const section = assembly.sections.find(entry => entry.name === name);
    const session = context.agent?.session ?? context.session;
    if (!section || !/^session-[\da-f-]+$/i.test(session?.id) || session.header?.origin === 'subagent') return assembly;
    const role = await requestVA({ type: 'deepseek-context', sessionId: session.id }, context.signal);
    return {
      ...assembly,
      sections: assembly.sections.map(entry => entry === section ? { ...entry, text: role?.prompt ?? '' } : entry),
    };
  });
  ctx.inject(['connection'], web => {
    web.connection.fetch.register({
      path: '/api/va-desktop-navigation',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        if (!request.headers.has('x-va-navigation')) {
          return new Response(null, { status: 403 });
        }
        const done = new URL(request.url).searchParams.get('done');
        const result = await requestVA({ type: 'deepseek-navigation', done });
        const headers = { 'Cache-Control': 'no-store' };
        if (!result?.navigation) return new Response(null, { status: 204, headers });
        return Response.json(result.navigation, { headers });
      },
    });
  });
}
