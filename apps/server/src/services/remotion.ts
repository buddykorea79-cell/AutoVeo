import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {
  access,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {cpus, tmpdir} from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath, pathToFileURL} from "node:url";
import {spawn} from "node:child_process";

import {renderPlanSchema, type RenderPlan} from "@travel-movie/schema";

import type {StorageAdapter} from "../storage/storage-adapter.js";
import type {RemotionWorkerMessage, RemotionWorkerRequest} from "./remotion-worker-protocol.js";

export interface RemotionRenderOptions {
  readonly onProgress?: (progress: number) => void;
  readonly outputKey?: string;
  readonly planKey?: string;
  readonly signal?: AbortSignal;
}

export interface RemotionRenderResult {
  readonly outputKey: string;
  readonly outputPath: string;
  readonly planKey: string;
  readonly size: number;
}

export interface RemotionRenderDependencies {
  readonly browserExecutable?: string | null;
  readonly remotionRoot: string;
  readonly storage: StorageAdapter;
  readonly workerPath?: string;
}

/**
 * 렌더는 반드시 work/ 아래에서 우리가 만든 파일만 읽는다.
 * 원본 경로가 렌더 계획에 새어 들어가는 것을 여기서 막는다.
 */
const VIDEO_ASSET_PREFIXES = ["render-assets/", "clips/", "proxies/", "generated/"] as const;

const validateAssetKeys = async (plan: RenderPlan, storage: StorageAdapter): Promise<void> => {
  for (const scene of plan.scenes) {
    if (scene.type === "photo") {
      if (scene.assetKey === null || !scene.assetKey.startsWith("render-assets/")) {
        throw new Error(`Photo scene ${scene.id} must use a render-assets/ key`);
      }
    } else if (scene.type === "video") {
      if (
        scene.assetKey === null ||
        !VIDEO_ASSET_PREFIXES.some((prefix) => scene.assetKey!.startsWith(prefix))
      ) {
        throw new Error(
          `Video scene ${scene.id} must use one of ${VIDEO_ASSET_PREFIXES.join(", ")}`,
        );
      }
    } else if (scene.type === "montage") {
      if (scene.montage === null) {
        throw new Error(`Montage scene ${scene.id} requires montage items`);
      }
      for (const item of scene.montage.items) {
        if (!item.assetKey.startsWith("render-assets/") || !(await storage.exists(item.assetKey))) {
          throw new Error(`Montage render asset does not exist: ${item.assetKey}`);
        }
      }
      continue;
    } else {
      continue;
    }
    if (!(await storage.exists(scene.assetKey))) {
      throw new Error(`Render asset does not exist: ${scene.assetKey}`);
    }
  }
};

const resolveWorkerPath = async (configured: string | undefined): Promise<string> => {
  const candidates = [
    configured,
    fileURLToPath(new URL("./remotion-worker.js", import.meta.url)),
    path.resolve(
      fileURLToPath(new URL("../../../../", import.meta.url)),
      "apps/server/src/services/remotion-worker.ts",
    ),
    path.resolve(
      fileURLToPath(new URL("../../../../", import.meta.url)),
      "apps/server/dist/services/remotion-worker.js",
    ),
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next compiled worker location.
    }
  }
  throw new Error("Compiled Remotion worker is missing. Build @travel-movie/server first.");
};

export const remotionWorkerArguments = (
  workerPath: string,
  requestPath: string,
  tsxLoaderUrl?: string,
): string[] => {
  if (!workerPath.endsWith(".ts")) {
    return [workerPath, requestPath];
  }
  const loaderUrl =
    tsxLoaderUrl ?? pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return ["--import", loaderUrl, workerPath, requestPath];
};

const copyFont = async (remotionRoot: string, storage: StorageAdapter): Promise<void> => {
  const font = await readFile(path.join(remotionRoot, "src", "fonts", "PretendardVariable.woff2"));
  const fontKey = "fonts/PretendardVariable.woff2";
  const expectedHash = createHash("sha256").update(font).digest("hex");
  const currentHash = await storage
    .read(fontKey)
    .then((value) => createHash("sha256").update(value).digest("hex"))
    .catch(() => null);
  if (currentHash !== expectedHash) {
    await storage.write(fontKey, font);
  }
};

export class RemotionRenderService {
  readonly #browserExecutable: string | null;
  readonly #remotionRoot: string;
  readonly #storage: StorageAdapter;
  readonly #workerPath: string | undefined;

  constructor(dependencies: RemotionRenderDependencies) {
    this.#browserExecutable = dependencies.browserExecutable ?? null;
    this.#remotionRoot = path.resolve(dependencies.remotionRoot);
    this.#storage = dependencies.storage;
    this.#workerPath = dependencies.workerPath;
  }

  /**
   * Remotion 번들의 public 폴더에 이 렌더가 실제로 쓰는 파일만 심는다.
   * 폴더 심볼릭 링크는 Windows 에서 관리자 권한이 필요하므로 파일 단위 하드링크를 쓰고,
   * 다른 볼륨이라 하드링크가 안 되면 복사로 물러난다.
   */
  async #stagePublicAssets(plan: RenderPlan, planKey: string, publicDir: string): Promise<void> {
    const keys = new Set<string>([planKey, "fonts/PretendardVariable.woff2"]);
    for (const scene of plan.scenes) {
      if (scene.assetKey !== null) {
        keys.add(scene.assetKey);
      }
      for (const item of scene.montage?.items ?? []) {
        keys.add(item.assetKey);
      }
    }
    for (const key of keys) {
      const sourcePath = await this.#storage.localPath(key);
      try {
        await access(sourcePath);
      } catch {
        throw new Error(`렌더에 필요한 파일이 없습니다: ${key}`);
      }
      const targetPath = path.join(publicDir, ...key.split("/"));
      await mkdir(path.dirname(targetPath), {recursive: true});
      try {
        await link(sourcePath, targetPath);
      } catch {
        await copyFile(sourcePath, targetPath);
      }
    }
  }

  async render(
    inputPlan: RenderPlan,
    options: RemotionRenderOptions = {},
  ): Promise<RemotionRenderResult> {
    const plan = renderPlanSchema.parse(inputPlan);
    if (plan.totalFrames <= 0) {
      throw new Error("Cannot render an empty plan");
    }
    await validateAssetKeys(plan, this.#storage);
    await copyFont(this.#remotionRoot, this.#storage);
    const planKey = options.planKey ?? "plans/current.json";
    const outputKey = options.outputKey ?? "intermediate.mp4";
    await this.#storage.write(planKey, Buffer.from(JSON.stringify(plan, null, 2)));
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "travel-remotion-"));
    const publicDir = path.join(temporaryRoot, "public");
    await mkdir(publicDir, {recursive: true});
    await this.#stagePublicAssets(plan, planKey, publicDir);

    try {
      const temporaryOutput = path.join(temporaryRoot, "intermediate.mp4");
      const request: RemotionWorkerRequest = {
        browserExecutable: this.#browserExecutable,
        compositionId: "TravelMovie",
        concurrency: Math.max(1, cpus().length - 2),
        entryPoint: path.join(this.#remotionRoot, "src", "index.ts"),
        outputLocation: temporaryOutput,
        planPath: planKey.replaceAll(path.sep, "/"),
        publicDir,
        workDirectory: temporaryRoot,
      };
      const requestPath = path.join(temporaryRoot, "request.json");
      await writeFile(requestPath, JSON.stringify(request));
      const workerPath = await resolveWorkerPath(this.#workerPath);
      await new Promise<void>((resolve, reject) => {
        const workerArguments = remotionWorkerArguments(workerPath, requestPath);
        const child = spawn(process.execPath, workerArguments, {
          cwd: this.#remotionRoot,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const stderr: Buffer[] = [];
        let stdout = "";
        let settled = false;
        let abortReason: unknown = null;
        let lastProgress = -1;
        const finish = (callback: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          options.signal?.removeEventListener("abort", abort);
          callback();
        };
        const abort = (): void => {
          abortReason = options.signal?.reason ?? new Error("Remotion render was cancelled");
          child.kill();
        };
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          const lines = stdout.split(/\r?\n/u);
          stdout = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const message = JSON.parse(line) as RemotionWorkerMessage;
              if (
                message.type === "progress" &&
                Number.isFinite(message.progress) &&
                message.progress > lastProgress
              ) {
                lastProgress = message.progress;
                options.onProgress?.(message.progress);
              }
            } catch {
              // Remotion may emit informational output; only JSON progress messages are consumed.
            }
          }
        });
        child.once("error", (error) => finish(() => reject(error)));
        child.once("close", (code) => {
          finish(() => {
            if (abortReason !== null) {
              reject(abortReason);
            } else if (code === 0) {
              resolve();
            } else {
              reject(
                new Error(
                  `Remotion worker exited with ${String(code)}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
                ),
              );
            }
          });
        });
        options.signal?.addEventListener("abort", abort, {once: true});
        if (options.signal?.aborted === true) {
          abort();
        }
      });

      const rendered = await stat(temporaryOutput);
      if (rendered.size <= 0) {
        throw new Error("Remotion produced an empty output");
      }
      await this.#storage.write(outputKey, createReadStream(temporaryOutput));
      const outputPath = await this.#storage.localPath(outputKey);
      return {outputKey, outputPath, planKey, size: rendered.size};
    } finally {
      await rm(temporaryRoot, {force: true, maxRetries: 5, recursive: true, retryDelay: 100});
    }
  }
}
