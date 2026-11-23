import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { ChatEvent, ConfirmRequest, FreeProviderId, MemoryKind, Settings } from '../shared/types';
import { FREE_PROVIDER_PRESETS } from '../shared/types';
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
  onRestart?: () => void;
  onCameraFrame?: (requestId: string, frame: { mime: string; base64: string; width: number; height: number } | null) => void;
}): { sendConfirm: (r: ConfirmRequest) => void; closeConfirm: (id: string) => void; sendCameraRequest: (id: string) => void; sendJobResult: (r: unknown) => void; sendTelegram: (r: unknown) => void; sendAgent: (r: unknown) => void } {
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
  handle(IPC.realtimeConnect, (_e, sdp) => core.realtime.connect(str(sdp, 'sdp', 100_000)));
  handle(IPC.realtimeEnded, (_e, sec) => core.realtime.ended(sec));
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

  handle(IPC.kbList, () => core.mentor.kb.list());
  handle(IPC.kbSave, (_e, doc) => {
    const d = doc as Record<string, unknown>;
    return core.saveKbDoc({
      id: d.id === undefined || d.id === null ? undefined : int(d.id, 'id'),
      title: str(d.title, 'title', 300),
      category: str(d.category, 'category', 30),
      body: str(d.body, 'body', 70_000),
      source: d.source === undefined ? '' : str(d.source, 'source', 300),
    });
  });
  handle(IPC.kbApprove, (_e, id, approved) => core.approveKbDoc(int(id, 'id'), approved === true));
  handle(IPC.kbRemove, (_e, id) => core.removeKbDoc(int(id, 'id')));
  handle(IPC.kbImport, async () => {
    const test = process.env.JARVIS_E2E_PICK;
    let path: string | null = null;
    if (test && !app.isPackaged) path = JSON.parse(test).kbFile ?? null;
    else {
      const w = getWindow();
      const o: Electron.OpenDialogOptions = { title: 'Выберите текстовый документ для базы знаний', properties: ['openFile'], filters: [{ name: 'Текст', extensions: ['txt', 'md', 'csv'] }] };
      const r = w ? await dialog.showOpenDialog(w, o) : await dialog.showOpenDialog(o);
      path = r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    }
    if (!path) return null;
    if (statSync(path).size > 1_000_000) throw new Error('Файл слишком большой (больше 1 МБ)');
    const raw = readFileSync(path, 'utf8');
    if (raw.includes('\u0000')) throw new Error('Это не текстовый файл');
    return { name: basename(path).replace(/\.[^.]+$/, ''), text: raw.slice(0, 60_000) };
  });
  handle(IPC.mentorCourses, () => core.mentor.courses());
  handle(IPC.mentorLesson, (_e, email, c, l) => core.mentor.lesson(str(email, 'email', 200), str(c, 'course', 50), str(l, 'lesson', 50)));
  handle(IPC.mentorAnswer, (_e, email, c, l, idx, choice) => core.mentor.answer(str(email, 'email', 200), str(c, 'course', 50), str(l, 'lesson', 50), int(idx, 'step'), int(choice, 'choice')));
  handle(IPC.mentorVerify, (_e, email, c, l, idx, self) => core.mentor.verifyTask(str(email, 'email', 200), str(c, 'course', 50), str(l, 'lesson', 50), int(idx, 'step'), self === true));
  handle(IPC.mentorShow, (_e, c, l, idx) => core.mentor.show(str(c, 'course', 50), str(l, 'lesson', 50), int(idx, 'step')));
  handle(IPC.mentorAssign, (_e, email, name, c, due) => core.mentor.assign(str(email, 'email', 200), str(name, 'name', 100), str(c, 'course', 50), due ? str(due, 'due', 40) : null));
  handle(IPC.mentorUnassign, (_e, email, c) => core.mentor.unassign(str(email, 'email', 200), str(c, 'course', 50)));
  handle(IPC.mentorAssignments, (_e, email) => core.mentor.assignmentsFor(str(email, 'email', 200)));
  handle(IPC.mentorCabinet, () => core.mentor.cabinet());
  handle(IPC.jobsList, () => core.listJobs());
  handle(IPC.jobsCreate, (_e, input) => {
    const i = input as Record<string, unknown>;
    return core.createJob({
      title: str(i.title, 'title', 200),
      prompt: str(i.prompt, 'prompt', 5000),
      kind: str(i.kind, 'kind', 20) as 'daily',
      atTime: i.atTime === undefined || i.atTime === null ? null : str(i.atTime, 'atTime', 10),
      intervalMin: i.intervalMin === undefined || i.intervalMin === null ? null : int(i.intervalMin, 'intervalMin'),
      runAt: i.runAt === undefined || i.runAt === null ? null : str(i.runAt, 'runAt', 40),
      notify: i.notify !== false,
      speak: i.speak === true,
    });
  });
  handle(IPC.jobsToggle, (_e, id, enabled) => core.setJobEnabled(int(id, 'id'), enabled === true));
  handle(IPC.jobsDelete, (_e, id) => core.deleteJob(int(id, 'id')));
  handle(IPC.jobsRunNow, async (_e, id) => {
    const r = await core.runJobNow(int(id, 'id'));
    return { job: r.job, status: r.status, summary: r.summary, quiet: r.quiet };
  });
  handle(IPC.jobsRuns, (_e, id) => core.jobRuns(int(id, 'id')));
  const provId = (v: unknown): FreeProviderId => {
    if (typeof v !== 'string' || !FREE_PROVIDER_PRESETS.some((p) => p.id === v)) throw new Error('Неизвестная модель');
    return v as FreeProviderId;
  };
  handle(IPC.appsStartMenu, () => core.startMenuApps());
  handle(IPC.appsSetStartMenu, (_e, on) => core.setStartMenuAccess(on === true));
  handle(IPC.appsLaunch, (_e, q) => core.launchAppByName(str(q, 'query', 100)));
  handle(IPC.ytStatus, () => core.youtubeStatus());
  handle(IPC.ytSetKey, (_e, key) => core.setYoutubeKey(str(key, 'key', 400)));
  handle(IPC.ytClearKey, () => core.clearYoutubeKey());
  handle(IPC.ytTest, () => core.testYoutube());
  handle(IPC.agentsList, () => core.listAgents());
  handle(IPC.agentsTemplates, () => core.agentTemplates());
  handle(IPC.agentsSave, (_e, input) => {
    const i = input as Record<string, unknown>;
    const sch = (i.schedule ?? {}) as Record<string, unknown>;
    return core.saveAgent({
      id: i.id === undefined || i.id === null ? undefined : int(i.id, 'id'),
      name: str(i.name, 'name', 60),
      description: i.description ? str(i.description, 'description', 300) : '',
      instructions: str(i.instructions, 'instructions', 5000),
      groups: Array.isArray(i.groups) ? (i.groups.map((g) => str(g, 'group', 30)) as never) : [],
      mode: i.mode === 'act' ? 'act' : 'read',
      schedule: { kind: (['daily', 'weekdays', 'interval'].includes(String(sch.kind)) ? sch.kind : 'none') as never, atTime: typeof sch.atTime === 'string' ? sch.atTime : null, intervalMin: typeof sch.intervalMin === 'number' ? sch.intervalMin : null },
      enabled: i.enabled === true,
    });
  });
  handle(IPC.agentsDelete, (_e, id) => core.deleteAgent(int(id, 'id')));
  handle(IPC.agentsRun, (_e, id, task) => core.startAgent(int(id, 'id'), typeof task === 'string' ? task.slice(0, 2000) : ''));
  handle(IPC.agentsStop, (_e, id) => core.stopAgent(int(id, 'id')));
  handle(IPC.agentsRuns, (_e, id) => core.agentRuns(int(id, 'id')));
  handle(IPC.agentsClearNotes, (_e, id) => core.clearAgentNotes(int(id, 'id')));
  handle(IPC.tgStatus, () => core.telegramStatus());
  handle(IPC.tgConnect, (_e, token) => core.telegramConnect(str(token, 'token', 200)));
  handle(IPC.tgDisconnect, () => core.telegramDisconnect());
  handle(IPC.tgPairCode, () => core.telegramPairCode());
  handle(IPC.tgUnlink, () => {
    core.telegramUnlink();
    return core.telegramStatus();
  });
  handle(IPC.tgChats, () => core.telegramChats());
  handle(IPC.tgMessages, (_e, id) => core.telegramMessages(int(id, 'chatId')));
  handle(IPC.tgSend, async (_e, id, text) => {
    await core.telegramSend(int(id, 'chatId'), str(text, 'text', 4000));
    return core.telegramMessages(int(id, 'chatId'));
  });
  handle(IPC.tgAutoReply, (_e, id, on) => {
    core.telegramSetAutoReply(int(id, 'chatId'), on === true);
    return core.telegramChats();
  });
  handle(IPC.tgResolve, (_e, id) => {
    core.telegramResolveHuman(int(id, 'chatId'));
    return core.telegramChats();
  });
  handle(IPC.modelsList, () => core.providerStatuses());
  handle(IPC.modelsSetKey, (_e, id, key) => {
    core.setProviderKey(provId(id), str(key, 'key', 400));
    return core.providerStatuses();
  });
  handle(IPC.modelsClearKey, (_e, id) => {
    core.clearProviderKey(provId(id));
    return core.providerStatuses();
  });
  handle(IPC.modelsTest, (_e, id) => core.testProvider(provId(id)));
  handle(IPC.telStatus, () => core.telephonyStatus());
  handle(IPC.telConsents, () => core.listConsents());
  handle(IPC.telGrant, (_e, i) => {
    const c = i as { phone?: unknown; name?: unknown; email?: unknown; recording?: unknown; source?: unknown; confirmed?: unknown };
    core.grantConsent({ phone: str(c.phone, 'phone', 40), name: str(c.name, 'name', 80), email: c.email ? str(c.email, 'email', 200) : '', recording: c.recording === true, source: c.source ? str(c.source, 'source', 200) : '', confirmed: c.confirmed === true });
    return core.listConsents();
  });
  handle(IPC.telRevoke, (_e, phone) => {
    core.revokeConsent(str(phone, 'phone', 40));
    return core.listConsents();
  });
  handle(IPC.telCanCall, (_e, phone) => core.canCall(str(phone, 'phone', 40)));
  handle(IPC.telStart, (_e, i) => {
    const c = i as { phone?: unknown; courseId?: unknown; lessonId?: unknown };
    return core.startCall({ phone: str(c.phone, 'phone', 40), courseId: str(c.courseId, 'courseId', 60), lessonId: str(c.lessonId, 'lessonId', 60) });
  });
  handle(IPC.telState, (_e, id) => core.callState(int(id, 'id')));
  handle(IPC.telReply, (_e, id, text) => core.callReply(int(id, 'id'), str(text, 'text', 500)));
  handle(IPC.telHangup, (_e, id) => core.callHangup(int(id, 'id')));
  handle(IPC.telCalls, () => core.listCalls());
  handle(IPC.telTranscript, (_e, id) => core.callTranscript(int(id, 'id')));
  handle(IPC.telDeleteTranscript, (_e, id) => core.deleteCallTranscript(int(id, 'id')));
  handle(IPC.gatewayStatus, () => core.gatewayStatus());
  handle(IPC.gatewayCode, () => core.gatewayPairingCode());
  handle(IPC.gatewayDevices, () => core.listDevices());
  handle(IPC.gatewayRevoke, (_e, id) => {
    core.revokeDevice(int(id, 'id'));
    return core.listDevices();
  });
  handle(IPC.aquaGet, () => core.aquaStatus());
  handle(IPC.aquaSave, (_e, cfg, key) => {
    const c = cfg as { baseUrl?: unknown; maskPii?: unknown };
    return core.aquaSave({ baseUrl: c.baseUrl ? str(c.baseUrl, 'baseUrl', 200) : '', maskPii: c.maskPii !== false }, key === undefined || key === null ? undefined : str(key, 'key', 400));
  });
  handle(IPC.aquaDisconnect, () => core.aquaDisconnect());
  handle(IPC.aquaTest, () => core.aquaTest());
  handle(IPC.showStats, () => core.show.stats());
  handle(IPC.videoStatus, () => core.video.status());
  handle(IPC.videoPick, async () => {
    const test = process.env.JARVIS_E2E_PICK;
    let p: string | null = null;
    if (test && !app.isPackaged) p = (JSON.parse(test) as { folder?: string }).folder ?? null;
    else {
      const w = getWindow();
      const opts: Electron.OpenDialogOptions = { title: 'Выберите папку с видео для студии', properties: ['openDirectory'] };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      p = r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    }
    if (!p) return null;
    core.video.setFolder(p);
    return core.video.status();
  });
  handle(IPC.videoUseSuggested, () => {
    const s = core.video.suggested();
    if (!s) throw new Error('Папка «Видосы для системных» на рабочем столе не найдена. Выберите папку вручную.');
    core.video.setFolder(s);
    return core.video.status();
  });
  handle(IPC.videoList, () => core.video.list(true));
  handle(IPC.videoResults, () => core.video.results());
  handle(IPC.videoMontage, (_e, spec) => {
    const s = spec as Record<string, unknown>;
    return core.video.montageUi({
      face: str(s['face'], 'face', 300),
      reference: s['reference'] ? str(s['reference'], 'reference', 300) : undefined,
      layout: str(s['layout'], 'layout', 30) as 'talk',
      title: s['title'] ? str(s['title'], 'title', 80) : undefined,
      subtitles: s['subtitles'] !== false,
      subStyle: (['bold', 'neon', 'clean'].includes(String(s['subStyle'])) ? s['subStyle'] : 'bold') as 'bold',
      cover: s['cover'] === true,
      name: s['name'] ? str(s['name'], 'name', 60) : undefined,
    });
  });
  handle(IPC.videoOpen, async (_e, p) => {
    const path = str(p, 'path', 1000);
    if (!core.video.isInside(path)) throw new Error('Открывать можно только файлы из папки студии.');
    const err = await shell.openPath(path);
    if (err) throw new Error(`Не удалось открыть: ${err}`);
  });
  handle(IPC.videoStop, () => core.video.stop());
  handle(IPC.videoArt, async (_e, spec) => {
    const s = spec as Record<string, unknown>;
    const r = await core.video.channelArt({ name: str(s['name'], 'name', 80), tagline: typeof s['tagline'] === 'string' ? (s['tagline'] as string).slice(0, 100) : '', style: (['space', 'neon', 'minimal'].includes(String(s['style'])) ? s['style'] : 'space') as 'space', ai: s['ai'] === true, idea: typeof s['idea'] === 'string' ? (s['idea'] as string).slice(0, 500) : '' }, new AbortController().signal);
    return { dir: core.video.folder() ? `${core.video.folder()}` : '', banner: r.banner, avatar: r.avatar, bannerData: r.bannerData, avatarData: r.avatarData };
  });
  handle(IPC.ytuStatus, () => core.ytUpload.refreshStatus());
  handle(IPC.ytuSaveClient, (_e, id, secret) => core.ytUpload.saveClient(str(id, 'clientId', 300), secret ? str(secret, 'clientSecret', 300) : ''));
  handle(IPC.ytuConnect, () => core.ytUpload.connect());
  handle(IPC.ytuDisconnect, () => core.ytUpload.disconnect());
  handle(IPC.ytuUpload, (_e, spec) => {
    const s = spec as Record<string, unknown>;
    const r = core.video.resolveResult(str(s['video'], 'video', 300));
    return core.ytUpload.upload({
      file: r.video,
      thumbnail: r.cover,
      title: str(s['title'], 'title', 100),
      description: typeof s['description'] === 'string' ? (s['description'] as string).slice(0, 4900) : '',
      tags: Array.isArray(s['tags']) ? (s['tags'] as unknown[]).slice(0, 30).map((t) => String(t).slice(0, 40)) : [],
      privacy: (['private', 'unlisted', 'public'].includes(String(s['privacy'])) ? s['privacy'] : 'private') as 'private',
    });
  });
  const STEPS: Record<string, string> = {
    lang: 'https://console.cloud.google.com/user-preferences',
    project: 'https://console.cloud.google.com/projectcreate',
    api: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
    consent: 'https://console.cloud.google.com/auth/overview',
    audience: 'https://console.cloud.google.com/auth/audience',
    client: 'https://console.cloud.google.com/auth/clients/create',
  };
  handle(IPC.ytuOpenStep, async (_e, step) => {
    const url = STEPS[str(step, 'step', 20)];
    if (!url) throw new Error('Неизвестный шаг.');
    await shell.openExternal(url); // адреса зашиты выше, из интерфейса пришёл только номер шага
  });
  core.onUploadProgress((p) => send(IPC.evtYtu, p));
  core.video.onPlan((p) => send(IPC.evtVideo, p));
  core.show.onDeck((d) => send(IPC.evtShow, d));
  handle(IPC.aquaDashboard, () => core.aquaDashboard());
  handle(IPC.aquaSection, (_e, kind, arg) => {
    const a = (arg ?? {}) as { pipeline?: unknown; stage?: unknown };
    const k = str(kind, 'kind', 20);
    if (!['production', 'tasks', 'stuck', 'unassigned', 'lowstock', 'stage'].includes(k)) throw new Error('Неизвестный раздел');
    return core.aquaSection(k as Parameters<typeof core.aquaSection>[0], { pipeline: a.pipeline ? str(a.pipeline, 'pipeline', 120) : '', stage: a.stage ? str(a.stage, 'stage', 120) : '' });
  });
  handle(IPC.crmGet, () => core.crmStatus());
  handle(IPC.crmSave, (_e, cfg, password) => {
    const c = cfg as { baseUrl?: unknown; environment?: unknown; email?: unknown; maskPii?: unknown; frontendUrl?: unknown };
    return core.crmSave(
      { baseUrl: str(c.baseUrl, 'baseUrl', 200), environment: c.environment === 'production' ? 'production' : 'test', email: str(c.email, 'email', 200), maskPii: c.maskPii !== false, frontendUrl: c.frontendUrl ? str(c.frontendUrl, 'frontendUrl', 200) : '' },
      password === undefined || password === null ? undefined : str(password, 'password', 300),
    );
  });
  handle(IPC.crmDisconnect, () => core.crmDisconnect());
  handle(IPC.crmTest, () => core.crmTest());
  handle(IPC.crmDashboard, () => core.crmDashboard());
  handle(IPC.updateCheck, () => core.checkUpdate());
  handle(IPC.updateApply, () => core.applyUpdate((p) => send(IPC.evtUpdate, p)));
  handle(IPC.updateRestart, () => {
    opts.onRestart?.();
  });
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
    sendJobResult: (r: unknown) => send(IPC.evtJob, r),
    sendTelegram: (r: unknown) => send(IPC.evtTelegram, r),
    sendAgent: (r: unknown) => send(IPC.evtAgent, r),
    closeConfirm: (id) => send(IPC.evtConfirmClosed, id),
  };
}
