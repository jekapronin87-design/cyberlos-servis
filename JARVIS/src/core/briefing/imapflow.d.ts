// Минимальное описание нужной части imapflow (своих типов у пакета нет).
declare module 'imapflow' {
  export interface FetchMessage {
    uid: number;
    envelope?: { date?: Date | string; subject?: string; from?: { name?: string; address?: string }[] };
    flags?: Set<string>;
    labels?: Set<string>;
    internalDate?: Date | string;
  }
  export class ImapFlow {
    constructor(opts: { host: string; port: number; secure: boolean; auth: { user: string; pass: string }; logger: false; socketTimeout?: number });
    on(ev: string, cb: (...a: unknown[]) => void): void;
    connect(): Promise<void>;
    getMailboxLock(path: string, opts?: { readOnly?: boolean }): Promise<{ release(): void }>;
    search(q: Record<string, unknown>, opts?: { uid?: boolean }): Promise<number[] | false>;
    fetch(range: number[], query: Record<string, unknown>, opts?: { uid?: boolean }): AsyncIterable<FetchMessage>;
    logout(): Promise<void>;
  }
}
