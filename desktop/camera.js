import { BrowserWindow, session, systemPreferences } from 'electron';
import { ControlError } from '../lib/control.js';

const page = 'va-app://desktop/camera.html';
const script = 'va-app://desktop/camera-frame.js';
const permissionError = () => new ControlError('CAMERA_PERMISSION', process.platform === 'darwin'
  ? '请在 macOS「隐私与安全性 → 摄像头」允许 VA 使用摄像头，然后重启 VA。'
  : '请在 Windows「隐私和安全性 → 相机」允许桌面应用访问相机。');

async function allowCamera() {
  const status = systemPreferences.getMediaAccessStatus('camera');
  if (status === 'denied' || status === 'restricted') throw permissionError();
  if (process.platform === 'darwin' && status !== 'granted' &&
      !await systemPreferences.askForMediaAccess('camera')) throw permissionError();
}

export function createCameraCapture(serveAsset) {
  let cameraSession;
  let busy = false;
  return async signal => {
    if (busy) throw new ControlError('CAMERA_BUSY', '摄像头正在拍照，请稍后重试。');
    busy = true;
    let window;
    let timer;
    let onAbort;
    let finished = false;
    try {
      signal.throwIfAborted();
      const canceled = new Promise((_, reject) => {
        onAbort = () => reject(new ControlError('CAMERA_TIMEOUT', '摄像头没有及时完成拍照。'));
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(onAbort, 30_000);
      });
      const frame = await Promise.race([canceled, (async () => {
        await allowCamera();
        signal.throwIfAborted();
        if (finished) return;
        if (!cameraSession) {
          cameraSession = session.fromPartition('va-camera');
          cameraSession.protocol.handle('va-app', request => [page, script].includes(request.url)
            ? serveAsset(request) : new Response(null, { status: 404 }));
        }
        window = new BrowserWindow({ show: false, webPreferences: {
          session: cameraSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
          backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
        } });
        const web = window.webContents;
        web.setWindowOpenHandler(() => ({ action: 'deny' }));
        web.on('will-navigate', event => event.preventDefault());
        const ownPage = (contents, permission, details) => contents === web && permission === 'media' &&
          details.isMainFrame && details.requestingUrl === page;
        cameraSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
          ownPage(contents, permission, details) && details.mediaType === 'video');
        cameraSession.setPermissionRequestHandler((contents, permission, callback, details) =>
          callback(ownPage(contents, permission, details) &&
            details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'video'));
        await window.loadURL(page);
        return web.executeJavaScript('window.capturePhoto()');
      })()]);
      if (['NotAllowedError', 'SecurityError'].includes(frame?.cameraError)) throw permissionError();
      if (!frame?.data) throw new ControlError('CAMERA_UNAVAILABLE', '无法从摄像头取景。请确认摄像头已连接，并关闭占用它的应用。');
      return { ...frame, capturedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError('CAMERA_UNAVAILABLE', '无法从摄像头取景。请确认摄像头已连接，并关闭占用它的应用。');
    } finally {
      finished = true;
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (window && !window.isDestroyed()) window.destroy();
      busy = false;
    }
  };
}
