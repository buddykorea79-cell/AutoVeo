import {spawn} from "node:child_process";

export interface FfmpegRunOptions {
  readonly durationSec?: number;
  readonly onProgress?: (progress: number) => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface MediaTranscoder {
  run(args: readonly string[], options?: FfmpegRunOptions): Promise<void>;
}

export class FfmpegService implements MediaTranscoder {
  readonly #binaryPath: string;
  readonly #defaultTimeoutMs: number;

  constructor(binaryPath: string, defaultTimeoutMs = 10 * 60_000) {
    this.#binaryPath = binaryPath;
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  async run(args: readonly string[], options: FfmpegRunOptions = {}): Promise<void> {
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new Error("FFmpeg operation was aborted");
    }

    if (
      options.onProgress !== undefined &&
      (options.durationSec === undefined ||
        !Number.isFinite(options.durationSec) ||
        options.durationSec <= 0)
    ) {
      throw new RangeError("A positive durationSec is required for FFmpeg progress reporting");
    }

    await new Promise<void>((resolve, reject) => {
      const effectiveArgs =
        options.onProgress === undefined ? args : ["-progress", "pipe:1", "-nostats", ...args];
      const child = spawn(this.#binaryPath, effectiveArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stderr: Buffer[] = [];
      let stdoutBuffer = "";
      let lastProgress = -1;
      let settled = false;
      const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        callback();
      };
      const abort = (): void => {
        child.kill();
        finish(() => reject(options.signal?.reason ?? new Error("FFmpeg operation was aborted")));
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdout.on("data", (chunk: Buffer) => {
        if (options.onProgress === undefined || options.durationSec === undefined) {
          return;
        }
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/u);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "progress=end") {
            if (lastProgress < 1) {
              lastProgress = 1;
              options.onProgress(1);
            }
            continue;
          }
          const match = /^out_time_(?:ms|us)=(\d+)$/u.exec(line);
          if (match === null) {
            continue;
          }
          const progress = Math.max(
            0,
            Math.min(1, Number(match[1]) / 1_000_000 / options.durationSec),
          );
          if (progress > lastProgress) {
            lastProgress = progress;
            options.onProgress(progress);
          }
        }
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => {
        finish(() => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(
            new Error(
              `FFmpeg exited with code ${String(code)}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
            ),
          );
        });
      });
      options.signal?.addEventListener("abort", abort, {once: true});
    });
  }
}
