import { randomUUID } from 'node:crypto';
import type { ConfirmRequest } from '../../shared/types';

export type ConfirmInput = Omit<ConfirmRequest, 'id'>;

/** Канал, через который запрос показывается пользователю (в Electron — окно подтверждения). */
export interface ConfirmationUi {
  show(req: ConfirmRequest): void;
  close(id: string): void;
}

interface Pending {
  req: ConfirmRequest;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

/**
 * Запросы подтверждения опасных действий. Любой исход, кроме явного «Разрешить»
 * (отмена, «Стоп», таймаут, закрытие), считается отказом.
 */
export class ConfirmationBroker {
  private pending = new Map<string, Pending>();

  constructor(
    private ui: ConfirmationUi,
    private timeoutMs = 120_000,
  ) {}

  request(input: ConfirmInput, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal?.aborted) return resolve(false);
      const id = randomUUID();
      const req: ConfirmRequest = { ...input, id };
      const finish = (approved: boolean): void => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        this.ui.close(id);
        resolve(approved);
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      this.pending.set(id, { req, resolve: finish, timer });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.ui.show(req);
    });
  }

  /** Ответ пользователя. Неизвестный id игнорируется. */
  respond(id: string, approve: boolean): void {
    this.pending.get(id)?.resolve(approve === true);
  }

  /** Отклонить всё ожидающее (кнопка «Стоп»). */
  rejectAll(): void {
    for (const p of [...this.pending.values()]) p.resolve(false);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
