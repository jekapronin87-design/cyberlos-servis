import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisCore, type CoreOptions } from '../src/core/app';
import { DemoProvider } from '../src/core/providers/demo';
import { MemorySecretStore } from '../src/core/security/secrets';
import type { ConfirmRequest, ChatEvent } from '../src/shared/types';

export interface Harness {
  core: JarvisCore;
  confirms: ConfirmRequest[];
  closed: string[];
  /** Автоответ на запросы подтверждения. */
  autoAnswer: { value: boolean | 'manual' };
  events: ChatEvent[];
  secrets: MemorySecretStore;
  dir: string;
}

export function makeCore(over: Partial<CoreOptions> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-test-'));
  const confirms: ConfirmRequest[] = [];
  const closed: string[] = [];
  const autoAnswer: Harness['autoAnswer'] = { value: true };
  const secrets = new MemorySecretStore();
  const h = { core: undefined as unknown as JarvisCore } as Harness;
  const core = new JarvisCore({
    dbPath: ':memory:',
    dataDir: dir,
    version: 'test',
    platform: 'test',
    secrets,
    env: {},
    demoProvider: new DemoProvider(0),
    confirmUi: {
      show: (req) => {
        confirms.push(req);
        if (autoAnswer.value !== 'manual') queueMicrotask(() => h.core.confirm.respond(req.id, autoAnswer.value as boolean));
      },
      close: (id) => closed.push(id),
    },
    ...over,
  });
  Object.assign(h, { core, confirms, closed, autoAnswer, events: [], secrets, dir });
  return h;
}

/** Выполнить сообщение целиком и вернуть события. */
export async function chat(h: Harness, text: string, conversationId?: number): Promise<{ id: number; events: ChatEvent[] }> {
  const id = conversationId ?? h.core.createConversation().id;
  const events: ChatEvent[] = [];
  const { done } = h.core.startChat(id, text, (e) => {
    events.push(e);
    h.events.push(e);
  });
  await done;
  return { id, events };
}
