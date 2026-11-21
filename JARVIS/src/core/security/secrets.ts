import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Хранилище секретов (API-ключи, токены). Значения никогда не передаются в рендерер. */
export interface SecretStore {
  /** Данные шифруются средствами ОС (а не лежат открытым текстом). */
  readonly encrypted: boolean;
  set(name: string, value: string): void;
  get(name: string): string | null;
  delete(name: string): void;
  has(name: string): boolean;
}

/** Только в памяти — для тестов и как безопасный запасной вариант, если шифрование ОС недоступно. */
export class MemorySecretStore implements SecretStore {
  readonly encrypted = false;
  private map = new Map<string, string>();
  set(name: string, value: string): void {
    this.map.set(name, value);
  }
  get(name: string): string | null {
    return this.map.get(name) ?? null;
  }
  delete(name: string): void {
    this.map.delete(name);
  }
  has(name: string): boolean {
    return this.map.has(name);
  }
}

/** Минимальный контракт Electron safeStorage (DPAPI на Windows). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Хранит секреты в файле, зашифрованными через ОС (Windows DPAPI).
 * Если шифрование недоступно — секреты НЕ пишутся на диск и живут только до закрытия приложения.
 */
export class OsEncryptedSecretStore implements SecretStore {
  private cache = new Map<string, string>();
  private blobs: Record<string, string> = {};

  constructor(
    private safe: SafeStorageLike,
    private filePath: string,
  ) {
    if (this.encrypted && existsSync(filePath)) {
      try {
        this.blobs = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>;
      } catch {
        this.blobs = {};
      }
    }
  }

  get encrypted(): boolean {
    return this.safe.isEncryptionAvailable();
  }

  set(name: string, value: string): void {
    this.cache.set(name, value);
    if (!this.encrypted) return;
    this.blobs[name] = this.safe.encryptString(value).toString('base64');
    this.flush();
  }

  get(name: string): string | null {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;
    const blob = this.blobs[name];
    if (!blob || !this.encrypted) return null;
    try {
      const plain = this.safe.decryptString(Buffer.from(blob, 'base64'));
      this.cache.set(name, plain);
      return plain;
    } catch {
      return null;
    }
  }

  delete(name: string): void {
    this.cache.delete(name);
    if (name in this.blobs) {
      delete this.blobs[name];
      this.flush();
    }
  }

  has(name: string): boolean {
    return this.get(name) !== null;
  }

  private flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.blobs), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}

export const SECRET_ANTHROPIC_KEY = 'anthropic.apiKey';

/** Грубая проверка формата ключа Anthropic (не гарантирует валидность). */
export function validateApiKey(key: string): string {
  const k = key.trim();
  if (k.length < 20 || k.length > 300 || /\s/.test(k)) throw new Error('Ключ выглядит некорректно');
  return k;
}
