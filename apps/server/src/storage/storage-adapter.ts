import type {Readable} from "node:stream";

export interface StorageAdapter {
  read(key: string): Promise<Buffer>;
  write(key: string, data: Buffer | Readable): Promise<void>;
  delete(key: string): Promise<void>;
  localPath(key: string): Promise<string>;
  publicUrl(key: string): string;
  exists(key: string): Promise<boolean>;
}

export const isStorageKeyEscapeError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("Storage key must be relative") ||
    error.message.includes("Storage key escapes the configured root"));
