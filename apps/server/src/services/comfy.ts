import {createHash, randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

import {makeStepCacheKey} from "../jobs/cache-key.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";
import type {MediaProbe} from "./ffprobe.js";

export const COMFY_CLIP_CODE_VERSION = 2;

const promptResponseSchema = z.object({prompt_id: z.string().min(1)}).passthrough();
const uploadResponseSchema = z
  .object({
    name: z.string().min(1),
    subfolder: z.string().default(""),
    type: z.string().default("input"),
  })
  .passthrough();
const workflowSchema = z.record(
  z.string(),
  z
    .object({
      class_type: z.string().min(1),
      inputs: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
);
const requiredWorkflowPlaceholders = [
  "{{INPUT_IMAGE}}",
  "{{OUTPUT_PREFIX}}",
  "{{PROMPT}}",
  "{{TARGET_FRAMES}}",
] as const;

interface ComfyDependencies {
  readonly baseUrl: string;
  readonly fetcher?: typeof fetch;
  readonly probe: MediaProbe;
  readonly storage: StorageAdapter;
  readonly workflowPath: string;
}

export interface ComfyStatus {
  readonly available: boolean;
  readonly baseUrl: string;
  readonly error: string | null;
  readonly workflowPath: string;
}

export interface ComfyGenerateInput {
  readonly fps: number;
  readonly height: number;
  readonly inputHash: string;
  readonly negativePrompt: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly sceneId: string;
  readonly seed: number;
  readonly sourceBuffer: Buffer;
  readonly sourceFilename: string;
  readonly targetFrames: number;
  readonly width: number;
}

const normalizeBaseUrl = (value: string): string => {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("ComfyUI 주소는 http 또는 https를 사용해야 합니다.");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) {
    throw new Error("ComfyUI 주소는 localhost, 127.0.0.1 또는 ::1이어야 합니다.");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/u, "");
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const replaceWorkflowPlaceholders = (
  value: unknown,
  replacements: Readonly<Record<string, string | number>>,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => replaceWorkflowPlaceholders(entry, replacements));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceWorkflowPlaceholders(entry, replacements),
      ]),
    );
  }
  if (typeof value !== "string") {
    return value;
  }
  const exact = replacements[value];
  if (exact !== undefined) {
    return exact;
  }
  return Object.entries(replacements).reduce(
    (result, [token, replacement]) => result.replaceAll(token, String(replacement)),
    value,
  );
};

const workflowStrings = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => workflowStrings(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((entry) => workflowStrings(entry));
  }
  return typeof value === "string" ? [value] : [];
};

const parseWorkflow = (buffer: Buffer): z.infer<typeof workflowSchema> => {
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new Error("ComfyUI 워크플로가 올바른 JSON이 아닙니다.", {cause: error});
  }
  const workflow = workflowSchema.parse(value);
  if (Object.keys(workflow).length === 0) {
    throw new Error("ComfyUI API 워크플로에 노드가 없습니다.");
  }
  const strings = workflowStrings(workflow);
  const missing = requiredWorkflowPlaceholders.filter(
    (placeholder) => !strings.some((value) => value.includes(placeholder)),
  );
  if (missing.length > 0) {
    throw new Error(`ComfyUI 워크플로 플레이스홀더가 없습니다: ${missing.join(", ")}`);
  }
  return workflow;
};

interface OutputFile {
  readonly filename: string;
  readonly subfolder: string;
  readonly type: string;
}

const findMp4Output = (value: unknown): OutputFile | null => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findMp4Output(entry);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.filename === "string" && record.filename.toLowerCase().endsWith(".mp4")) {
    return {
      filename: record.filename,
      subfolder: typeof record.subfolder === "string" ? record.subfolder : "",
      type: typeof record.type === "string" ? record.type : "output",
    };
  }
  for (const entry of Object.values(record)) {
    const found = findMp4Output(entry);
    if (found !== null) {
      return found;
    }
  }
  return null;
};

export class ComfyService {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #probe: MediaProbe;
  readonly #storage: StorageAdapter;
  readonly #workflowPath: string;

  constructor(dependencies: ComfyDependencies) {
    this.#baseUrl = normalizeBaseUrl(dependencies.baseUrl);
    this.#fetch = dependencies.fetcher ?? fetch;
    this.#probe = dependencies.probe;
    this.#storage = dependencies.storage;
    this.#workflowPath = path.resolve(dependencies.workflowPath);
  }

  async status(): Promise<ComfyStatus> {
    try {
      parseWorkflow(await readFile(this.#workflowPath));
      const response = await this.#fetch(`${this.#baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`ComfyUI status returned HTTP ${String(response.status)}`);
      }
      await response.json();
      return {
        available: true,
        baseUrl: this.#baseUrl,
        error: null,
        workflowPath: this.#workflowPath,
      };
    } catch (error) {
      return {
        available: false,
        baseUrl: this.#baseUrl,
        error: errorMessage(error),
        workflowPath: this.#workflowPath,
      };
    }
  }

  async generateClip(input: ComfyGenerateInput, signal?: AbortSignal): Promise<string> {
    const workflowBuffer = await readFile(this.#workflowPath);
    const workflowTemplate = parseWorkflow(workflowBuffer);
    const workflowHash = createHash("sha1").update(workflowBuffer).digest("hex");
    const cacheKey = makeStepCacheKey(
      "comfy-i2v",
      COMFY_CLIP_CODE_VERSION,
      createHash("sha1").update(input.inputHash).update(workflowHash).digest("hex"),
      {
        fps: input.fps,
        height: input.height,
        negativePrompt: input.negativePrompt,
        prompt: input.prompt,
        seed: input.seed,
        targetFrames: input.targetFrames,
        width: input.width,
      },
    );
    const outputKey = `generated/${input.projectId}/${input.sceneId}/${cacheKey}.mp4`;
    if (await this.#storage.exists(outputKey)) {
      await this.#validateOutput(outputKey, input.targetFrames, input.fps);
      return outputKey;
    }
    const upload = await this.#uploadImage(
      input.sourceBuffer,
      `${cacheKey}-${path.basename(input.sourceFilename)}`,
      signal,
    );
    const workflow = replaceWorkflowPlaceholders(workflowTemplate, {
      "{{FPS}}": input.fps,
      "{{HEIGHT}}": input.height,
      "{{INPUT_IMAGE}}":
        upload.subfolder.length === 0 ? upload.name : `${upload.subfolder}/${upload.name}`,
      "{{NEGATIVE_PROMPT}}": input.negativePrompt,
      "{{OUTPUT_PREFIX}}": `travel_${cacheKey}`,
      "{{PROMPT}}": input.prompt,
      "{{SEED}}": input.seed,
      "{{TARGET_FRAMES}}": input.targetFrames,
      "{{WIDTH}}": input.width,
    });
    const clientId = randomUUID();
    const submitted = await this.#fetch(`${this.#baseUrl}/prompt`, {
      body: JSON.stringify({client_id: clientId, prompt: workflow}),
      headers: {"Content-Type": "application/json"},
      method: "POST",
      signal: this.#requestSignal(signal, 30_000),
    });
    if (!submitted.ok) {
      const body = await submitted.text().catch(() => "");
      throw new Error(
        `ComfyUI prompt returned HTTP ${String(submitted.status)}${body.length === 0 ? "" : `: ${body.slice(0, 500)}`}`,
      );
    }
    const promptId = promptResponseSchema.parse(await submitted.json()).prompt_id;
    const file = await this.#waitForMp4(promptId, signal);
    const viewUrl = new URL(`${this.#baseUrl}/view`);
    viewUrl.searchParams.set("filename", file.filename);
    viewUrl.searchParams.set("subfolder", file.subfolder);
    viewUrl.searchParams.set("type", file.type);
    const output = await this.#fetch(viewUrl, {signal: this.#requestSignal(signal, 60_000)});
    if (!output.ok) {
      throw new Error(`ComfyUI output returned HTTP ${String(output.status)}`);
    }
    await this.#storage.write(outputKey, Buffer.from(await output.arrayBuffer()));
    try {
      await this.#validateOutput(outputKey, input.targetFrames, input.fps);
      return outputKey;
    } catch (error) {
      await this.#storage.delete(outputKey);
      throw error;
    }
  }

  async #uploadImage(
    image: Buffer,
    filename: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof uploadResponseSchema>> {
    const form = new FormData();
    const bytes = new Uint8Array(image.byteLength);
    bytes.set(image);
    form.append("image", new Blob([bytes]), path.basename(filename));
    form.append("overwrite", "true");
    form.append("type", "input");
    const response = await this.#fetch(`${this.#baseUrl}/upload/image`, {
      body: form,
      method: "POST",
      signal: this.#requestSignal(signal, 60_000),
    });
    if (!response.ok) {
      throw new Error(`ComfyUI image upload returned HTTP ${String(response.status)}`);
    }
    return uploadResponseSchema.parse(await response.json());
  }

  async #waitForMp4(promptId: string, signal?: AbortSignal): Promise<OutputFile> {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      if (signal?.aborted === true) {
        throw signal.reason ?? new Error("ComfyUI generation was aborted");
      }
      const response = await this.#fetch(
        `${this.#baseUrl}/history/${encodeURIComponent(promptId)}`,
        {signal: this.#requestSignal(signal, 15_000)},
      );
      if (response.ok) {
        const history = (await response.json()) as Record<string, unknown>;
        const record = history[promptId];
        const file = findMp4Output(record);
        if (file !== null) {
          return file;
        }
        if (
          record !== null &&
          typeof record === "object" &&
          JSON.stringify(record).includes("execution_error")
        ) {
          throw new Error("ComfyUI workflow execution failed");
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("ComfyUI generation timed out after 15 minutes");
  }

  async #validateOutput(outputKey: string, targetFrames: number, fps: number): Promise<void> {
    const outputPath = await this.#storage.localPath(outputKey);
    const metadata = await this.#probe.probe(outputPath);
    const video = metadata.streams?.find((stream) => stream.codec_type === "video");
    const duration = Number(metadata.format?.duration ?? video?.duration ?? "0");
    const minimumDuration = targetFrames / fps - 1 / fps;
    if (video === undefined || !Number.isFinite(duration) || duration < minimumDuration) {
      throw new Error(
        `ComfyUI output is shorter than the planned scene (${duration.toFixed(3)}s < ${minimumDuration.toFixed(3)}s)`,
      );
    }
  }

  #requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }
}
