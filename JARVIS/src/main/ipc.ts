import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { ChatEvent, ConfirmRequest, MemoryKind } from '../shared/types';
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
}): { sendConfirm: (r: ConfirmRequest) => void; closeConfirm: (id: string) => void } {
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
  handle(IPC.settingsUpdate, (_e, patch) => core.updateSettings(patch));
  handle(IPC.apiKeySet, (_e, key) => core.setApiKey(str(key, 'key', 400)));
  handle(IPC.apiKeyClear, () => core.clearApiKey());

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
    closeConfirm: (id) => send(IPC.evtConfirmClosed, id),
  };
}
