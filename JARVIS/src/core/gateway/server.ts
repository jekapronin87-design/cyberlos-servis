import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { ChatEvent, ChatMessage, Conversation, GatewayStatusDto, Settings } from '../../shared/types';
import type { AuditLog } from '../security/audit';
import { DeviceRepo, PairingCodes, RateLimiter, type Device } from './devices';
import { APP_CSS, APP_JS, INDEX_HTML, MANIFEST } from './page';

const MAX_BODY = 16 * 1024;
export const DEFAULT_PORT = 8787;

export interface RemoteRun {
  runId: string;
  abort(): void;
  done: Promise<void>;
}

export interface GatewayDeps {
  devices: DeviceRepo;
  codes: PairingCodes;
  audit: AuditLog;
  getSettings: () => Settings;
  mode: () => 'demo' | 'live';
  conversations: { create(title?: string): Conversation; get(id: number): Conversation | null | undefined; messages(id: number): ChatMessage[] };
  startRemoteChat(device: Device, conversationId: number, text: string, emit: (e: ChatEvent) => void): RemoteRun;
  /** Есть ли на компьютере запрос подтверждения, ожидающий пользователя. */
  waitingForPc: () => boolean;
  port?: number;
}

interface RunState {
  status: 'running' | 'done' | 'stopped' | 'error';
  reply: string;
  error?: string;
  run?: RemoteRun;
}

const isLoopback = (a: string): boolean => a === '::1' || a === '127.0.0.1' || a.startsWith('127.') || a === '::ffff:127.0.0.1';

/** Адрес из домашней сети (или этот же компьютер). Интернет-адреса отвергаются даже если порт случайно открыт наружу. */
export function isLocalNetworkAddress(addr: string): boolean {
  let a = addr.toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (isLoopback(a)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (m) {
    const [x, y] = [Number(m[1]), Number(m[2])];
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
  }
  return a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd');
}

/** Защита от DNS-rebinding: Host — только IP-адрес или localhost. */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  return /^(localhost|\[[0-9a-f:]+\]|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?$/i.test(host);
}

export function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && isLocalNetworkAddress(i.address)) out.push(`http://${i.address}:${port}`);
    }
  }
  return out;
}

/**
 * Шлюз для телефона. По умолчанию выключен. Доступ: сопряжённый телефон (одноразовый код с компьютера → личный токен),
 * только из локальной сети, лимиты запросов, без CORS. С телефона — тот же чат; опасные действия подчиняются удалённой политике (см. ToolExecutor).
 */
export class Gateway {
  private server: Server | null = null;
  private port = 0;
  private mode: GatewayStatusDto['mode'] = 'off';
  private error: string | undefined;
  private runs = new Map<number, RunState>();
  private pairLimit = new RateLimiter(10, 10 * 60_000);
  private authLimit = new RateLimiter(120, 60_000);
  private failLimit = new RateLimiter(20, 10 * 60_000);

  constructor(private d: GatewayDeps) {}

  status(): GatewayStatusDto {
    const running = this.server !== null;
    return {
      mode: this.mode,
      running,
      port: this.port,
      urls: !running ? [] : this.mode === 'lan' ? lanUrls(this.port) : [`http://127.0.0.1:${this.port}`],
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Привести сервер в соответствие с настройкой. */
  async apply(mode: GatewayStatusDto['mode']): Promise<GatewayStatusDto> {
    if (mode === this.mode && (mode === 'off' || this.server)) return this.status();
    await this.stop();
    this.mode = mode;
    this.error = undefined;
    if (mode === 'off') return this.status();
    try {
      await this.listen(mode === 'lan' ? '0.0.0.0' : '127.0.0.1');
      this.d.audit.record({ actor: 'system', action: 'gateway.start', decision: 'info', details: { mode, port: this.port } });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.server = null;
    }
    return this.status();
  }

  async stop(): Promise<void> {
    for (const s of this.runs.values()) s.run?.abort();
    this.runs.clear();
    const srv = this.server;
    this.server = null;
    if (!srv) return;
    await new Promise<void>((res) => {
      srv.close(() => res());
      srv.closeAllConnections?.();
    });
    this.d.codes.clear();
    this.d.audit.record({ actor: 'system', action: 'gateway.stop', decision: 'info' });
  }

  private listen(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) this.json(res, 500, { error: 'Внутренняя ошибка' });
          else res.end();
        });
      });
      srv.on('error', (e: NodeJS.ErrnoException) => reject(new Error(e.code === 'EADDRINUSE' ? 'Порт занят другой программой' : e.message)));
      srv.listen(this.d.port ?? DEFAULT_PORT, host, () => {
        this.server = srv;
        this.port = (srv.address() as { port: number }).port;
        resolve();
      });
    });
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(text);
  }

  private readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('Слишком большой запрос'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (size === 0) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
        } catch {
          reject(new Error('Некорректный запрос'));
        }
      });
      req.on('error', reject);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? '';
    const allowed = this.mode === 'lan' ? isLocalNetworkAddress(remote) : isLoopback(remote);
    if (!allowed || !hostAllowed(req.headers.host)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const page = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };

    if (method === 'GET') {
      const csp = "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
      if (path === '/') return void (res.writeHead(200, { ...page, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp }), res.end(INDEX_HTML));
      if (path === '/app.js') return void (res.writeHead(200, { ...page, 'Content-Type': 'text/javascript; charset=utf-8' }), res.end(APP_JS));
      if (path === '/app.css') return void (res.writeHead(200, { ...page, 'Content-Type': 'text/css; charset=utf-8' }), res.end(APP_CSS));
      if (path === '/manifest.webmanifest') return void (res.writeHead(200, { ...page, 'Content-Type': 'application/manifest+json' }), res.end(MANIFEST));
    }
    if (!path.startsWith('/api/')) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      if (method === 'POST' && path === '/api/pair') {
        if (!this.pairLimit.hit(remote)) return this.json(res, 429, { error: 'Слишком много попыток. Подождите несколько минут.' });
        const body = await this.readBody(req);
        if (!this.d.codes.consume(String(body.code ?? ''))) {
          this.d.audit.record({ actor: 'device', action: 'gateway.pair_failed', decision: 'denied', details: { from: remote } });
          return this.json(res, 403, { error: 'Неверный или просроченный код. Покажите новый код на компьютере.' });
        }
        const dev = this.d.devices.create(String(body.name ?? ''));
        this.d.audit.record({ actor: 'device', action: 'gateway.paired', target: String(dev.id), decision: 'info', details: { from: remote } });
        return this.json(res, 200, { token: dev.token });
      }

      const auth = /^Bearer ([0-9a-f]{64})$/.exec(String(req.headers.authorization ?? ''));
      const device = auth ? this.d.devices.authenticate(auth[1]!) : null;
      if (!device) {
        if (!this.failLimit.hit(remote)) return this.json(res, 429, { error: 'Слишком много попыток' });
        return this.json(res, 401, { error: 'Требуется подключение телефона' });
      }
      if (!this.authLimit.hit(String(device.id))) return this.json(res, 429, { error: 'Слишком часто. Подождите минуту.' });

      if (method === 'GET' && path === '/api/me') {
        return this.json(res, 200, { name: device.name, mode: this.d.mode(), busy: this.runs.get(device.id)?.status === 'running' });
      }
      if (method === 'GET' && path === '/api/messages') {
        const conv = this.deviceConversation(device, false);
        const msgs = conv ? this.d.conversations.messages(conv).slice(-40) : [];
        const out = msgs
          .filter((m) => m.role !== 'tool')
          .map((m) => ({ role: m.role, text: m.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim() }))
          .filter((m) => m.text);
        return this.json(res, 200, { messages: out });
      }
      if (method === 'POST' && path === '/api/chat') {
        const body = await this.readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return this.json(res, 400, { error: 'Пустое сообщение' });
        if (text.length > 4000) return this.json(res, 400, { error: 'Слишком длинное сообщение' });
        if ([...this.runs.values()].some((r) => r.status === 'running')) return this.json(res, 409, { error: 'JARVIS ещё отвечает. Подождите или нажмите «Стоп».' });
        const conv = this.deviceConversation(device, true)!;
        const state: RunState = { status: 'running', reply: '' };
        this.runs.set(device.id, state);
        this.d.audit.record({ actor: 'device', action: 'gateway.chat', target: String(device.id), decision: 'info', details: { name: device.name, chars: text.length } });
        state.run = this.d.startRemoteChat(device, conv, text, (e) => {
          if (e.type === 'message' && e.message.role === 'assistant') {
            const t = e.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
            if (t) state.reply = t;
          } else if (e.type === 'run_finished') {
            state.status = e.status;
            if (e.error) state.error = e.error;
          }
        });
        state.run.done.catch(() => undefined).finally(() => {
          if (state.status === 'running') state.status = 'error';
        });
        return this.json(res, 202, { runId: state.run.runId });
      }
      if (method === 'GET' && path === '/api/run') {
        const s = this.runs.get(device.id);
        if (!s) return this.json(res, 200, { status: 'none' });
        return this.json(res, 200, { status: s.status, reply: s.status === 'running' ? '' : s.reply, error: s.error, waitingForPc: s.status === 'running' && this.d.waitingForPc() });
      }
      if (method === 'POST' && path === '/api/stop') {
        this.runs.get(device.id)?.run?.abort();
        this.d.audit.record({ actor: 'device', action: 'gateway.stop', target: String(device.id), decision: 'info' });
        return this.json(res, 200, { ok: true });
      }
      if (method === 'POST' && path === '/api/logout') {
        this.runs.get(device.id)?.run?.abort();
        this.d.devices.revoke(device.id);
        this.d.audit.record({ actor: 'device', action: 'gateway.logout', target: String(device.id), decision: 'info' });
        return this.json(res, 200, { ok: true });
      }
      return this.json(res, 404, { error: 'Не найдено' });
    } catch (e) {
      return this.json(res, 400, { error: e instanceof Error ? e.message : 'Ошибка запроса' });
    }
  }

  private deviceConversation(device: Device, create: boolean): number | null {
    let id = device.conversationId;
    if (id && !this.d.conversations.get(id)) id = null;
    if (!id && create) {
      id = this.d.conversations.create(`С телефона: ${device.name}`).id;
      this.d.devices.setConversation(device.id, id);
      device.conversationId = id;
    }
    return id;
  }
}
