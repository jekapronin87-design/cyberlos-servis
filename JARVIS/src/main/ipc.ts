import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { ChatEvent, ConfirmRequest, MemoryKind, Settings } from '../shared/types';
import type { JarvisCore } from '../core/app';

const int = (v: unknown, name: string): number => {
  if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`Некорректный параметр: ${name}`);
  return v as number;
};
const str = (v: unknown, name: string, max: number): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error(`Некорректный параметр: ${name}`);
  return v;
};

/**
 * Регистрирует IPC-обработчики. Каждый запрос проверяется:
 * отправитель должен быть нашим окном с нашей страницей (isTrusted), аргументы валидируются.
 */
export function registerIpc(opts: {
  core: JarvisCore;
  getWindow: () => BrowserWindow | null;
  isTrusted: (e: IpcMainInvokeEvent) => boolean;
  onSettings?: (next: Settings) => void;
  onCameraFrame?: (requestId: string, frame: { mime: string; base64: string; width: number; height: number } | null) => void;
}): { sendConfirm: (r: ConfirmRequest) => void; closeConfirm: (id: string) => void; sendCameraRequest: (id: string) => void } {
  const { core, getWindow, isTrusted } = opts;

  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, async (e, ...args) => {
      if (!isTrusted(e)) throw new Error('Недоверенный источник IPC-запроса');
      return fn(e, ...args);
    });
  };
  const send = (channel: string, payload: unknown): void => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  handle(IPC.appInfo, () => core.info());
  handle(IPC.settingsGet, () => core.getSettings());
  handle(IPC.settingsUpdate, (_e, patch) => {
    const next = core.updateSettings(patch);
    opts.onSettings?.(next);
    return next;
  });
  handle(IPC.cameraFrame, (_e, requestId, frame) => {
    const f = frame as { mime?: unknown; base64?: unknown; width?: unknown; height?: unknown } | null;
    const ok = f && typeof f.mime === 'string' && /^image\/(jpeg|png)$/.test(f.mime) && typeof f.base64 === 'string' && f.base64.length < 4_000_000;
    opts.onCameraFrame?.(str(requestId, 'requestId', 100), ok ? { mime: f.mime as string, base64: f.base64 as string, width: Number(f.width) || 0, height: Number(f.height) || 0 } : null);
  });
  handle(IPC.apiKeySet, (_e, key) => core.setApiKey(str(key, 'key', 400)));
  handle(IPC.apiKeyClear, () => core.clearApiKey());

  handle(IPC.voiceKeySet, (_e, key) => core.setVoiceKey(str(key, 'key', 400)));
  handle(IPC.voiceKeyClear, () => core.clearVoiceKey());
  handle(IPC.voiceTranscribe, async (_e, audio, mime) => {
    if (!(audio instanceof Uint8Array)) throw new Error('Некорректные аудиоданные');
    return core.voice.transcribe(audio, str(mime, 'mime', 100));
  });
  handle(IPC.voiceSpeak, (_e, text) => core.voice.speak(str(text, 'text', 4000)));

  // Доступ к компьютеру: пути выбирает только пользователь в окне Windows.
  const pick = async (kind: 'folder' | 'app'): Promise<string | null> => {
    const test = process.env.JARVIS_E2E_PICK; // только для автотестов неупакованной сборки
    if (test && !app.isPackaged) return JSON.parse(test)[kind] ?? null;
    const w = getWindow();
    const opts: Electron.OpenDialogOptions =
      kind === 'folder'
        ? { title: 'Выберите папку, с которой ассистенту можно работать', properties: ['openDirectory'] }
        : { title: 'Выберите программу, которую ассистенту можно запускать', properties: ['openFile'], filters: [{ name: 'Программы', extensions: ['exe'] }] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  };
  handle(IPC.computerGet, () => core.getComputerAccess());
  handle(IPC.computerAddFolder, async () => {
    const p = await pick('folder');
    return p ? core.addAllowedFolder(p) : null;
  });
  handle(IPC.computerRemoveFolder, (_e, p) => core.removeAllowedFolder(str(p, 'path', 1000)));
  handle(IPC.computerAddApp, async () => {
    const p = await pick('app');
    return p ? core.addAllowedApp(p) : null;
  });
  handle(IPC.computerRemoveApp, (_e, n) => core.removeAllowedApp(str(n, 'name', 100)));
  handle(IPC.computerAddHost, (_e, h) => core.addBrowserHost(str(h, 'host', 120)));
  handle(IPC.computerRemoveHost, (_e, h) => core.removeBrowserHost(str(h, 'host', 120)));
  handle(IPC.attachmentGet, (_e, id) => core.getAttachment(int(id, 'id')));

  handle(IPC.profileGet, () => core.getProfile());
  handle(IPC.profileSet, (_e, section, text) => core.setProfileSection(str(section, 'section', 30), str(text, 'text', 5000)));
  handle(IPC.profileClear, () => core.clearProfile());
  handle(IPC.profileImport, async () => {
    const test = process.env.JARVIS_E2E_PICK;
    let path: string | null = null;
    if (test && !app.isPackaged) path = JSON.parse(test).file ?? null;
    else {
      const w = getWindow();
      const opts: Electron.OpenDialogOptions = {
        title: 'Выберите текстовый файл с рассказом о себе',
        properties: ['openFile'],
        filters: [{ name: 'Текст', extensions: ['txt', 'md', 'json', 'csv'] }],
      };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      path = r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    }
    if (!path) return null;
    if (statSync(path).size > 2_000_000) throw new Error('Файл слишком большой (больше 2 МБ)');
    const raw = readFileSync(path, 'utf8');
    if (raw.includes('\u0000')) throw new Error('Это не текстовый файл');
    const MAX = 18_000;
    return { name: basename(path), text: raw.slice(0, MAX), truncated: raw.length > MAX };
  });

  handle(IPC.convList, () => core.listConversations());
  handle(IPC.convCreate, (_e, title) => core.createConversation(title === undefined ? undefined : str(title, 'title', 200)));
  handle(IPC.convRename, (_e, id, title) => core.renameConversation(int(id, 'id'), str(title, 'title', 200)));
  handle(IPC.convDelete, (_e, id) => core.deleteConversation(int(id, 'id')));
  handle(IPC.convMessages, (_e, id) => core.messages(int(id, 'id')));

  handle(IPC.chatSend, (_e, conversationId, text) => {
    const { runId } = core.startChat(int(conversationId, 'conversationId'), str(text, 'text', 25_000), (ev: ChatEvent) =>
      send(IPC.evtChat, ev),
    );
    return { runId };
  });
  handle(IPC.chatStop, () => core.stopAll());
  handle(IPC.confirmRespond, (_e, id, approve) => core.confirm.respond(str(id, 'id', 100), approve === true));

  handle(IPC.memoryList, () => core.listMemory());
  handle(IPC.memoryAdd, (_e, kind, content) => core.addMemory(str(kind, 'kind', 20) as MemoryKind, str(content, 'content', 2000)));
  handle(IPC.memoryDelete, (_e, id) => core.removeMemory(int(id, 'id')));

  handle(IPC.auditList, (_e, limit) => core.listAudit(limit === undefined ? 200 : int(limit, 'limit')));
  handle(IPC.auditVerify, () => core.verifyAudit());

  return {
    sendConfirm: (r) => send(IPC.evtConfirm, r),
    sendCameraRequest: (id: string) => send(IPC.evtCameraCapture, id),
    closeConfirm: (id) => send(IPC.evtConfirmClosed, id),
  };
}
