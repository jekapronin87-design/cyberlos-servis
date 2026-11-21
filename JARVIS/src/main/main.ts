import { app, BrowserWindow, desktopCapturer, safeStorage, screen, session, shell, type IpcMainInvokeEvent } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JarvisCore } from '../core/app';
import { OsEncryptedSecretStore } from '../core/security/secrets';
import { registerIpc } from './ipc';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_URL && !app.isPackaged;

app.setName('JARVIS');
// Голос Джарвиса должен воспроизводиться без предварительного клика (приветствие, ответы на голосовые команды).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Позволяет тестам и переносной установке указать каталог данных.
if (process.env.JARVIS_DATA_DIR) app.setPath('userData', process.env.JARVIS_DATA_DIR);

let win: BrowserWindow | null = null;
let core: JarvisCore | null = null;

const RENDERER_FILE = join(__dirname, '../renderer/index.html');

function csp(): string {
  const script = isDev ? "'self' 'unsafe-inline'" : "'self'";
  const connect = isDev ? "'self' ws: http://localhost:*" : "'self'";
  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  if (!win || e.sender !== win.webContents) return false;
  const url = e.senderFrame?.url ?? '';
  if (isDev) return url.startsWith(DEV_URL!);
  return url.startsWith('file://') && decodeURIComponent(url).replace(/\\/g, '/').includes('/dist/renderer/index.html');
}

/** Автозапуск вместе с Windows (только если пользователь включил в настройках). */
function applyLoginItem(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });
  } catch {
    /* не поддерживается на этой ОС */
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    title: 'JARVIS',
    backgroundColor: '#0b1020',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  // Запрет навигации и открытия окон: внешние ссылки — только в системном браузере по https.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL!) : url.startsWith('file://');
    if (!allowed) e.preventDefault();
  });

  if (isDev) void win.loadURL(DEV_URL!);
  else void win.loadFile(RENDERER_FILE);
}

function hardenSession(): void {
  const ses = session.defaultSession;
  // Микрофон — только при включённом главном выключателе микрофона, камера — только при включённом выключателе камеры.
  // Всё остальное (экран, геолокация, уведомления…) запрещено. Проверяется при каждом запросе.
  const mediaAllowed = (permission: string, types: string[], url: string): boolean => {
    if (permission !== 'media') return false;
    const st = core?.getSettings();
    if (!st) return false;
    const wanted = types.length ? types : ['audio'];
    for (const t of wanted) {
      if (t === 'audio' && !st.micEnabled) return false;
      if (t === 'video' && !st.cameraEnabled) return false;
      if (t !== 'audio' && t !== 'video') return false;
    }
    return isDev ? url.startsWith(DEV_URL!) : url.startsWith('file://');
  };
  ses.setPermissionRequestHandler((_wc, perm, cb, details) => {
    const d = details as { mediaTypes?: string[]; requestingUrl?: string };
    cb(mediaAllowed(perm, d.mediaTypes ?? [], d.requestingUrl ?? ''));
  });
  ses.setPermissionCheckHandler((_wc, perm, requestingOrigin, details) => {
    const d = details as { mediaType?: string; requestingUrl?: string };
    return mediaAllowed(perm, d.mediaType && d.mediaType !== 'unknown' ? [d.mediaType] : [], d.requestingUrl ?? requestingOrigin);
  });
  ses.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp()] } });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    hardenSession();
    const dataDir = app.getPath('userData');
    const secrets = new OsEncryptedSecretStore(safeStorage, join(dataDir, 'secrets.bin.json'));

    let ipc: ReturnType<typeof registerIpc> | null = null;
    // Запросы кадров с камеры: ассистент (ядро) просит окно снять кадр; окно отвечает, только если пользователь включил камеру.
    const cameraWaiters = new Map<string, (f: { mime: string; base64: string; width: number; height: number } | null) => void>();
    core = new JarvisCore({
      dbPath: join(dataDir, 'jarvis.db'),
      dataDir,
      version: app.getVersion(),
      platform: process.platform,
      secrets,
      // Только для автотестов неупакованной сборки: свой Chromium без окна.
      browser:
        !app.isPackaged && process.env.JARVIS_BROWSER_PATH
          ? { executablePath: process.env.JARVIS_BROWSER_PATH, headless: true, extraArgs: ['--no-sandbox', '--disable-gpu'] }
          : undefined,
      host: {
        captureCamera: () =>
          new Promise((resolve, reject) => {
            if (!ipc || !win) return reject(new Error('Окно JARVIS недоступно'));
            const id = randomUUID();
            const timer = setTimeout(() => {
              cameraWaiters.delete(id);
              reject(new Error('Камера не ответила. Включите кнопку «Камера» в окне JARVIS.'));
            }, 8000);
            cameraWaiters.set(id, (f) => {
              clearTimeout(timer);
              cameraWaiters.delete(id);
              if (f) resolve(f);
              else reject(new Error('Камера выключена. Попросите пользователя нажать кнопку «Камера» в окне JARVIS.'));
            });
            ipc.sendCameraRequest(id);
          }),
        trashItem: (p) => shell.trashItem(p),
        openPath: (p) => shell.openPath(p),
        launchApp: (exe) =>
          new Promise<void>((resolve, reject) => {
            // Без оболочки и без аргументов; процесс отвязан от JARVIS.
            const child = spawn(exe, [], { detached: true, stdio: 'ignore', shell: false });
            child.once('error', reject);
            child.once('spawn', () => {
              child.unref();
              resolve();
            });
          }),
        captureScreen: async () => {
          const d = screen.getPrimaryDisplay();
          const w = Math.min(1600, d.size.width);
          const h = Math.round((w / d.size.width) * d.size.height);
          const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
          const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
          if (!src || src.thumbnail.isEmpty()) throw new Error('Не удалось сделать снимок экрана');
          const size = src.thumbnail.getSize();
          return { mime: 'image/jpeg', base64: src.thumbnail.toJPEG(70).toString('base64'), width: size.width, height: size.height };
        },
      },
      confirmUi: {
        show: (r) => ipc?.sendConfirm(r),
        close: (id) => ipc?.closeConfirm(id),
      },
    });
    ipc = registerIpc({
      core,
      getWindow: () => win,
      isTrusted: isTrustedSender,
      onCameraFrame: (id, frame) => cameraWaiters.get(id)?.(frame),
      onSettings: (st) => applyLoginItem(st.launchAtLogin),
    });
    applyLoginItem(core.getSettings().launchAtLogin);

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  let closing = false;
  app.on('before-quit', (e) => {
    if (closing || !core) return;
    e.preventDefault(); // дождаться закрытия браузера ассистента и БД
    closing = true;
    const c = core;
    core = null;
    void c.close().finally(() => app.quit());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
