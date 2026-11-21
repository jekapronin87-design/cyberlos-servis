import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type JarvisApi } from '../shared/ipc';

// Единственный мост между интерфейсом и системой. Узкий, типизированный, без доступа к Node.
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const subscribe =
  <T>(channel: string) =>
  (cb: (payload: T) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };

const api: JarvisApi = {
  app: { info: () => invoke(IPC.appInfo) },
  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch) => invoke(IPC.settingsUpdate, patch),
  },
  secrets: {
    setApiKey: (key) => invoke(IPC.apiKeySet, key),
    clearApiKey: () => invoke(IPC.apiKeyClear),
  },
  voice: {
    setKey: (key) => invoke(IPC.voiceKeySet, key),
    clearKey: () => invoke(IPC.voiceKeyClear),
    transcribe: (audio, mime) => invoke(IPC.voiceTranscribe, audio, mime),
    speak: (text) => invoke(IPC.voiceSpeak, text),
  },
  computer: {
    get: () => invoke(IPC.computerGet),
    addFolder: () => invoke(IPC.computerAddFolder),
    removeFolder: (path) => invoke(IPC.computerRemoveFolder, path),
    addApp: () => invoke(IPC.computerAddApp),
    removeApp: (name) => invoke(IPC.computerRemoveApp, name),
    addBrowserHost: (host) => invoke(IPC.computerAddHost, host),
    removeBrowserHost: (host) => invoke(IPC.computerRemoveHost, host),
  },
  camera: {
    onCaptureRequest: subscribe(IPC.evtCameraCapture),
    sendFrame: (requestId, frame) => invoke(IPC.cameraFrame, requestId, frame),
  },
  profile: {
    get: () => invoke(IPC.profileGet),
    set: (section, text) => invoke(IPC.profileSet, section, text),
    clear: () => invoke(IPC.profileClear),
    importFile: () => invoke(IPC.profileImport),
  },
  attachments: { get: (id) => invoke(IPC.attachmentGet, id) },
  conversations: {
    list: () => invoke(IPC.convList),
    create: (title) => invoke(IPC.convCreate, title),
    rename: (id, title) => invoke(IPC.convRename, id, title),
    remove: (id) => invoke(IPC.convDelete, id),
    messages: (id) => invoke(IPC.convMessages, id),
  },
  chat: {
    send: (conversationId, text) => invoke(IPC.chatSend, conversationId, text),
    stop: () => invoke(IPC.chatStop),
    onEvent: subscribe(IPC.evtChat),
  },
  confirm: {
    respond: (id, approve) => invoke(IPC.confirmRespond, id, approve),
    onRequest: subscribe(IPC.evtConfirm),
    onClosed: subscribe(IPC.evtConfirmClosed),
  },
  memory: {
    list: () => invoke(IPC.memoryList),
    add: (kind, content) => invoke(IPC.memoryAdd, kind, content),
    remove: (id) => invoke(IPC.memoryDelete, id),
  },
  audit: {
    list: (limit) => invoke(IPC.auditList, limit),
    verify: () => invoke(IPC.auditVerify),
  },
};

contextBridge.exposeInMainWorld('jarvis', api);
