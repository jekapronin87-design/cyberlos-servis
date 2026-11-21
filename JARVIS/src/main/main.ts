import { app, BrowserWindow, desktopCapturer, safeStorage, screen, session, shell, type IpcMainInvokeEvent } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { JarvisCore } from '../core/app';
import { OsEncryptedSecretStore } from '../core/security/secrets';
import { registerIpc } from './ipc';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_URL && !app.isPackaged;

app.setName('JARVIS');
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
  // Разрешён только звук с микрофона для нашей страницы и только если микрофон включён в настройках.
  // Камера, экран и всё остальное запрещены (экран — этап 3, с отдельным разрешением).
  const micAllowed = (permission: string, details: { mediaTypes?: string[]; requestingUrl?: string }): boolean => {
    if (permission !== 'media') return false;
    if (!core?.getSettings().micEnabled) return false;
    if (details.mediaTypes && details.mediaTypes.some((t) => t !== 'audio')) return false;
    const url = details.requestingUrl ?? '';
    return isDev ? url.startsWith(DEV_URL!) : url.startsWith('file://');
  };
  ses.setPermissionRequestHandler((_wc, perm, cb, details) => cb(micAllowed(perm, details as never)));
  ses.setPermissionCheckHandler((_wc, perm, requestingOrigin, details) =>
    micAllowed(perm, { mediaType: undefined, requestingUrl: (details as { requestingUrl?: string }).requestingUrl ?? requestingOrigin } as never),
  );
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
    ipc = registerIpc({ core, getWindow: () => win, isTrusted: isTrustedSender });

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
