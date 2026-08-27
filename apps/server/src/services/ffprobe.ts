import {spawn} from "node:child_process";

export interface FfprobeStream {
  readonly avg_frame_rate?: string;
  readonly bit_rate?: string;
  readonly codec_name?: string;
  readonly codec_type?: string;
  readonly duration?: string;
  readonly height?: number;
  readonly r_frame_rate?: string;
  readonly sample_rate?: string;
  readonly side_data_list?: Array<{readonly rotation?: number}>;
  readonly tags?: Record<string, string>;
  readonly width?: number;
}

export interface FfprobeOutput {
  readonly format?: {
    readonly bit_rate?: string;
    readonly duration?: string;
    readonly tags?: Record<string, string>;
  };
  readonly streams?: FfprobeStream[];
}

export interface MediaProbe {
  probe(filePath: string): Promise<FfprobeOutput>;
}

export class FfprobeService implements MediaProbe {
  readonly #binaryPath: string;
  readonly #timeoutMs: number;

  constructor(binaryPath: string, timeoutMs = 30_000) {
    this.#binaryPath = binaryPath;
    this.#timeoutMs = timeoutMs;
  }

  async probe(filePath: string): Promise<FfprobeOutput> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.#binaryPath,
        ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
        {stdio: ["ignore", "pipe", "pipe"], windowsHide: true},
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`ffprobe timed out after ${this.#timeoutMs}ms: ${filePath}`));
      }, this.#timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(
            new Error(
              `ffprobe exited with code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
            ),
          );
          return;
        }

        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as FfprobeOutput);
        } catch (error) {
          reject(
            new Error(`ffprobe returned invalid JSON for ${filePath}`, {
              cause: error,
            }),
          );
        }
      });
    });
  }
}
