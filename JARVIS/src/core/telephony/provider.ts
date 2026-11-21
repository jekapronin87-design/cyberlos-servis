/**
 * Телефония — это интерфейс. Реальный оператор (SIP/Twilio/Zadarma…) подключается отдельной реализацией
 * TelephonyProvider; пока есть только симулятор, который звонит «в никуда» — разговор ведётся в окне JARVIS.
 */
export interface Line {
  /** Произнести фразу собеседнику. */
  say(text: string): Promise<void>;
  /** Услышать ответ. null — тишина/таймаут/трубку положили. */
  hear(timeoutMs: number, signal: AbortSignal): Promise<string | null>;
  hangup(): void;
}

export interface TelephonyProvider {
  readonly id: string;
  readonly name: string;
  /** Реальный оператор: набирает настоящие номера. Для таких провайдеров нужен явный выключатель в настройках. */
  readonly real: boolean;
  dial(phone: string, callId: number): Promise<Line>;
}

/** Линия-симулятор: реплики сотрудника вводит человек в окне (или тест через preload). */
export class SimulatorLine implements Line {
  readonly said: string[] = [];
  private queue: string[] = [];
  private waiter: ((v: string | null) => void) | null = null;
  hungUp = false;

  async say(text: string): Promise<void> {
    this.said.push(text);
  }

  hear(timeoutMs: number, signal: AbortSignal): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.hungUp || signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (v: string | null): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiter = null;
        resolve(v);
      };
      const onAbort = (): void => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiter = done;
    });
  }

  /** Реплика собеседника. */
  push(text: string): void {
    if (this.waiter) this.waiter(text);
    else this.queue.push(text);
  }

  get awaiting(): boolean {
    return this.waiter !== null;
  }

  hangup(): void {
    this.hungUp = true;
    this.waiter?.(null);
  }
}

export class SimulatorProvider implements TelephonyProvider {
  readonly id = 'simulator';
  readonly name = 'Симулятор (звонок в окне JARVIS, без связи)';
  readonly real = false;
  readonly lines = new Map<number, SimulatorLine>();

  async dial(_phone: string, callId: number): Promise<Line> {
    const line = new SimulatorLine();
    this.lines.set(callId, line);
    return line;
  }
}
