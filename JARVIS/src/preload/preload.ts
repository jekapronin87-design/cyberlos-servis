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
  kb: {
    list: () => invoke(IPC.kbList),
    save: (doc) => invoke(IPC.kbSave, doc),
    approve: (id, approved) => invoke(IPC.kbApprove, id, approved),
    remove: (id) => invoke(IPC.kbRemove, id),
    importFile: () => invoke(IPC.kbImport),
  },
  mentor: {
    courses: () => invoke(IPC.mentorCourses),
    lesson: (email, courseId, lessonId) => invoke(IPC.mentorLesson, email, courseId, lessonId),
    answer: (email, courseId, lessonId, stepIdx, choice) => invoke(IPC.mentorAnswer, email, courseId, lessonId, stepIdx, choice),
    verify: (email, courseId, lessonId, stepIdx, selfConfirmed) => invoke(IPC.mentorVerify, email, courseId, lessonId, stepIdx, selfConfirmed),
    show: (courseId, lessonId, stepIdx) => invoke(IPC.mentorShow, courseId, lessonId, stepIdx),
    assign: (email, name, courseId, dueAt) => invoke(IPC.mentorAssign, email, name, courseId, dueAt),
    unassign: (email, courseId) => invoke(IPC.mentorUnassign, email, courseId),
    assignments: (email) => invoke(IPC.mentorAssignments, email),
    cabinet: () => invoke(IPC.mentorCabinet),
  },
  jobs: {
    list: () => invoke(IPC.jobsList),
    create: (input) => invoke(IPC.jobsCreate, input),
    setEnabled: (id, enabled) => invoke(IPC.jobsToggle, id, enabled),
    remove: (id) => invoke(IPC.jobsDelete, id),
    runNow: (id) => invoke(IPC.jobsRunNow, id),
    runs: (id) => invoke(IPC.jobsRuns, id),
    onResult: subscribe(IPC.evtJob),
  },
  apps: {
    startMenu: () => invoke(IPC.appsStartMenu),
    setStartMenu: (on) => invoke(IPC.appsSetStartMenu, on),
    launch: (query) => invoke(IPC.appsLaunch, query),
  },
  youtube: {
    status: () => invoke(IPC.ytStatus),
    setKey: (key) => invoke(IPC.ytSetKey, key),
    clearKey: () => invoke(IPC.ytClearKey),
    test: () => invoke(IPC.ytTest),
  },
  agents: {
    list: () => invoke(IPC.agentsList),
    templates: () => invoke(IPC.agentsTemplates),
    save: (input) => invoke(IPC.agentsSave, input),
    remove: (id) => invoke(IPC.agentsDelete, id),
    run: (id, task) => invoke(IPC.agentsRun, id, task),
    stop: (id) => invoke(IPC.agentsStop, id),
    runs: (id) => invoke(IPC.agentsRuns, id),
    clearNotes: (id) => invoke(IPC.agentsClearNotes, id),
    onResult: subscribe(IPC.evtAgent),
  },
  telegram: {
    status: () => invoke(IPC.tgStatus),
    connect: (token) => invoke(IPC.tgConnect, token),
    disconnect: () => invoke(IPC.tgDisconnect),
    pairCode: () => invoke(IPC.tgPairCode),
    unlink: () => invoke(IPC.tgUnlink),
    chats: () => invoke(IPC.tgChats),
    messages: (chatId) => invoke(IPC.tgMessages, chatId),
    send: (chatId, text) => invoke(IPC.tgSend, chatId, text),
    setAutoReply: (chatId, on) => invoke(IPC.tgAutoReply, chatId, on),
    resolveHuman: (chatId) => invoke(IPC.tgResolve, chatId),
    onEvent: subscribe(IPC.evtTelegram),
  },
  models: {
    list: () => invoke(IPC.modelsList),
    setKey: (id, key) => invoke(IPC.modelsSetKey, id, key),
    clearKey: (id) => invoke(IPC.modelsClearKey, id),
    test: (id) => invoke(IPC.modelsTest, id),
  },
  telephony: {
    status: () => invoke(IPC.telStatus),
    consents: () => invoke(IPC.telConsents),
    grant: (i) => invoke(IPC.telGrant, i),
    revoke: (phone) => invoke(IPC.telRevoke, phone),
    canCall: (phone) => invoke(IPC.telCanCall, phone),
    start: (i) => invoke(IPC.telStart, i),
    state: (id) => invoke(IPC.telState, id),
    reply: (id, text) => invoke(IPC.telReply, id, text),
    hangup: (id) => invoke(IPC.telHangup, id),
    calls: () => invoke(IPC.telCalls),
    transcript: (id) => invoke(IPC.telTranscript, id),
    deleteTranscript: (id) => invoke(IPC.telDeleteTranscript, id),
  },
  gateway: {
    status: () => invoke(IPC.gatewayStatus),
    pairCode: () => invoke(IPC.gatewayCode),
    devices: () => invoke(IPC.gatewayDevices),
    revoke: (id) => invoke(IPC.gatewayRevoke, id),
  },
  crm: {
    get: () => invoke(IPC.crmGet),
    save: (cfg, password) => invoke(IPC.crmSave, cfg, password),
    disconnect: () => invoke(IPC.crmDisconnect),
    test: () => invoke(IPC.crmTest),
    dashboard: () => invoke(IPC.crmDashboard),
  },
  update: {
    check: () => invoke(IPC.updateCheck),
    apply: () => invoke(IPC.updateApply),
    restart: () => invoke(IPC.updateRestart),
    onProgress: subscribe(IPC.evtUpdate),
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
