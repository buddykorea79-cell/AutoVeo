import {randomUUID} from "node:crypto";
import {createReadStream, createWriteStream} from "node:fs";
import {access, mkdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import type {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";

import type {StorageAdapter} from "./storage-adapter.js";

export {isStorageKeyEscapeError} from "./storage-adapter.js";

const isReplaceError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "EPERM");

export class LocalFsAdapter implements StorageAdapter {
  readonly #root: string;
  readonly #publicBaseUrl: string;

  constructor(root: string, publicBaseUrl = "/assets") {
    this.#root = path.resolve(root);
    this.#publicBaseUrl = publicBaseUrl.replace(/\/$/u, "");
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.#resolveKey(key));
  }

  async write(key: string, data: Buffer | Readable): Promise<void> {
    const target = this.#resolveKey(key);
    await mkdir(path.dirname(target), {recursive: true});

    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;

    try {
      if (Buffer.isBuffer(data)) {
        await writeFile(temporary, data);
      } else {
        await pipeline(data, createWriteStream(temporary));
      }

      try {
        await rename(temporary, target);
      } catch (error) {
        if (!isReplaceError(error)) {
          throw error;
        }

        await rm(target, {force: true});
        await rename(temporary, target);
      }
    } catch (error) {
      await rm(temporary, {force: true});
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#resolveKey(key), {force: true});
  }

  async localPath(key: string): Promise<string> {
    return this.#resolveKey(key);
  }

  publicUrl(key: string): string {
    this.#resolveKey(key);
    const encodedKey = key
      .split(/[\\/]+/u)
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    return encodedKey.length === 0 ? this.#publicBaseUrl : `${this.#publicBaseUrl}/${encodedKey}`;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.#resolveKey(key));
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  createReadStream(key: string): NodeJS.ReadableStream {
    return createReadStream(this.#resolveKey(key));
  }

  #resolveKey(key: string): string {
    if (path.isAbsolute(key)) {
      throw new Error(`Storage key must be relative: ${key}`);
    }

    const target = path.resolve(this.#root, key);
    const isInsideRoot = target === this.#root || target.startsWith(`${this.#root}${path.sep}`);

    if (!isInsideRoot) {
      throw new Error(`Storage key escapes the configured root: ${key}`);
    }

    return target;
  }
}
