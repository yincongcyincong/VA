window.__ModuleLoader__.load({
  id: 'va-harness',
  factory: () => ({
    inject: ['uiWorkspace'],
    apply(ctx) {
      if (location.protocol !== 'dsh-app:') return;
      ctx.effect(() => {
        const abort = new AbortController();
        let busy = false;
        const read = path => fetch(path, {
          cache: 'no-store',
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1800)]),
          headers: { 'X-VA-Navigation': '1' },
        });
        const path = '/api/va-desktop-navigation';
        async function navigate() {
          if (busy || document.visibilityState !== 'visible') return;
          busy = true;
          try {
            const response = await read(path);
            if (response.status !== 200) return;
            const { id, token } = await response.json();
            if (!id || !token || abort.signal.aborted) return;
            ctx.uiWorkspace.openSession(id);
            if (ctx.uiWorkspace.selection.getSnapshot().sessionId === id) {
              await read(path + '?done=' + encodeURIComponent(token));
            }
          } catch {
            // The workspace and VA can start or stop independently.
          } finally {
            busy = false;
          }
        }
        const timer = setInterval(navigate, 600);
        window.addEventListener('focus', navigate);
        return () => {
          abort.abort();
          clearInterval(timer);
          window.removeEventListener('focus', navigate);
        };
      });
    },
  }),
});
