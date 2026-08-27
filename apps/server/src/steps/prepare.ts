import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {cpus, tmpdir, totalmem} from "node:os";
import path from "node:path";

import type BetterSqlite3 from "better-sqlite3";
import convertHeic from "heic-convert";
import pLimit from "p-limit";
import sharp from "sharp";

import {mediaIndexSchema, type MediaIndex, type MediaItem} from "@travel-movie/schema";

import type {MediaTranscoder} from "../services/ffmpeg.js";
import type {FfprobeOutput, MediaProbe} from "../services/ffprobe.js";
import {DEFAULT_MEDIA_MANIFEST_KEY, persistMediaIndex} from "../services/media-index.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";

export const PREPARE_CODE_VERSION = 3;

const THUMB_MAX_EDGE = 256;
const ANALYSIS_MAX_EDGE = 1024;
const VIDEO_PROXY_MAX_WIDTH = 1280;
const LARGE_FILE_BYTES = 512 * 1024 * 1024;
const CACHE_ROOT = "cache/prepare";

export type PrepareStage = "analysis" | "render" | "thumb";

export interface PrepareOptions {
  readonly force?: boolean;
  readonly mediaIds?: readonly string[];
  readonly renderTargetLongEdgePx?: number;
  readonly signal?: AbortSignal;
  readonly stages?: readonly PrepareStage[];
}

export interface PrepareProgress {
  readonly completed: number;
  readonly mediaId: string;
  readonly progress: number;
  readonly stage: PrepareStage;
  readonly total: number;
}

export interface PrepareDependencies {
  readonly concurrency?: number;
  readonly database: BetterSqlite3.Database;
  readonly manifestKey?: string;
  readonly onLog?: (message: string) => void;
  readonly onProgress?: (progress: PrepareProgress) => void;
  readonly probe: MediaProbe;
  readonly storage: StorageAdapter;
  readonly transcoder: MediaTranscoder;
}

export interface PrepareStatistics {
  readonly cacheHits: number;
  readonly completedOperations: number;
  readonly largeFilesSequential: number;
  readonly processed: number;
  readonly selectedMedia: number;
  readonly totalOperations: number;
}

export interface PrepareResult {
  readonly index: MediaIndex;
  readonly manifestKey: string;
  readonly statistics: PrepareStatistics;
}

interface PrepareCacheRecord {
  readonly cacheKey: string;
  readonly codeVersion: number;
  readonly createdAt: string;
  readonly mediaId: string;
  readonly outputKeys: readonly string[];
  readonly stage: PrepareStage;
}

interface ArtifactPatch {
  readonly analysisKey?: string;
  readonly proxyKey?: string;
  readonly renderAssetKey?: string;
  readonly rotationApplied?: boolean;
  readonly thumbKey?: string;
}

interface StagePlan {
  readonly cacheKey: string;
  readonly cacheRecordKey: string;
  readonly outputKeys: readonly string[];
  readonly params: Record<string, unknown>;
  readonly patch: ArtifactPatch;
}

const isHeic = (item: MediaItem): boolean => item.ext === "heic" || item.ext === "heif";

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const makePrepareCacheKey = (
  stage: PrepareStage,
  contentHash: string,
  params: Record<string, unknown>,
): string =>
  createHash("sha1")
    .update(
      [`prepare:${stage}`, PREPARE_CODE_VERSION, contentHash, stableStringify(params)].join("|"),
    )
    .digest("hex");

const getStagePlan = (
  item: MediaItem,
  stage: PrepareStage,
  renderTargetLongEdgePx: number,
): StagePlan => {
  const thumbKey = `thumbs/${item.id}.webp`;
  const analysisKey = `analysis/${item.id}.jpg`;
  const proxyKey = `proxies/${item.id}.mp4`;
  const renderAssetKey =
    item.mediaType === "video" ? `render-assets/${item.id}.mp4` : `render-assets/${item.id}.jpg`;
  let outputKeys: readonly string[];
  let patch: ArtifactPatch;
  let params: Record<string, unknown>;

  if (stage === "thumb") {
    outputKeys = [thumbKey];
    patch = {rotationApplied: item.mediaType === "photo" || item.rotationApplied, thumbKey};
    params = {
      format: "webp",
      maxEdge: THUMB_MAX_EDGE,
      mediaType: item.mediaType,
      quality: 72,
      videoFrame: "middle",
    };
  } else if (stage === "analysis") {
    outputKeys = item.mediaType === "video" ? [analysisKey, proxyKey] : [analysisKey];
    patch = {
      analysisKey,
      ...(item.mediaType === "video" ? {proxyKey, rotationApplied: true} : {rotationApplied: true}),
    };
    params = {
      format: "jpeg",
      maxEdge: ANALYSIS_MAX_EDGE,
      mediaType: item.mediaType,
      quality: 82,
      videoFrames: [0.25, 0.5, 0.75],
      videoProxy: {
        audioCodec: "aac",
        crf: 26,
        maxFps: 30,
        maxWidth: VIDEO_PROXY_MAX_WIDTH,
        videoCodec: "libx264",
      },
    };
  } else if (item.mediaType === "video") {
    // 렌더 단계에서는 미리보기 프록시가 아니라 출력 해상도에 맞춘 영상을 만든다.
    outputKeys = [renderAssetKey];
    patch = {renderAssetKey, rotationApplied: true};
    params = {
      mediaType: item.mediaType,
      videoProxy: {
        audioCodec: "aac",
        crf: 20,
        maxFps: 60,
        maxWidth: renderTargetLongEdgePx,
        videoCodec: "libx264",
      },
    };
  } else {
    const maxEdge = Math.round(renderTargetLongEdgePx * 1.4);
    outputKeys = [renderAssetKey];
    patch = {renderAssetKey, rotationApplied: true};
    params = {format: "jpeg", maxEdge, mediaType: item.mediaType, quality: 90};
  }

  const cacheKey = makePrepareCacheKey(stage, item.contentHash, params);
  return {
    cacheKey,
    cacheRecordKey: `${CACHE_ROOT}/${stage}/${item.id}.json`,
    outputKeys,
    params,
    patch,
  };
};

const readCacheRecord = async (
  storage: StorageAdapter,
  key: string,
): Promise<PrepareCacheRecord | null> => {
  try {
    const parsed = JSON.parse(
      (await storage.read(key)).toString("utf8"),
    ) as Partial<PrepareCacheRecord>;
    return typeof parsed.cacheKey === "string" && Array.isArray(parsed.outputKeys)
      ? (parsed as PrepareCacheRecord)
      : null;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      return null;
    }
    throw error;
  }
};

const isCacheHit = async (storage: StorageAdapter, plan: StagePlan): Promise<boolean> => {
  const record = await readCacheRecord(storage, plan.cacheRecordKey);
  return (
    record?.cacheKey === plan.cacheKey &&
    record.codeVersion === PREPARE_CODE_VERSION &&
    record.outputKeys.length === plan.outputKeys.length &&
    record.outputKeys.every((key, index) => key === plan.outputKeys[index]) &&
    (await Promise.all(plan.outputKeys.map((key) => storage.exists(key)))).every(Boolean)
  );
};

const writeCacheRecord = async (
  storage: StorageAdapter,
  item: MediaItem,
  stage: PrepareStage,
  plan: StagePlan,
): Promise<void> => {
  const record: PrepareCacheRecord = {
    cacheKey: plan.cacheKey,
    codeVersion: PREPARE_CODE_VERSION,
    createdAt: new Date().toISOString(),
    mediaId: item.id,
    outputKeys: plan.outputKeys,
    stage,
  };
  await storage.write(plan.cacheRecordKey, Buffer.from(JSON.stringify(record, null, 2)));
};

const imageInput = async (
  item: MediaItem,
  onLog: ((message: string) => void) | undefined,
): Promise<string | Buffer> => {
  if (!isHeic(item)) {
    return item.absolutePath;
  }

  onLog?.(`HEIC decoder: heic-convert -> sharp (${item.relativePath})`);
  const converted = await convertHeic({
    buffer: await readFile(item.absolutePath),
    format: "JPEG",
    quality: 1,
  });
  return Buffer.from(converted);
};

const verifyImage = async (
  storage: StorageAdapter,
  key: string,
  maxEdge: number,
  expectedFormat: "jpeg" | "webp",
): Promise<void> => {
  const filePath = await storage.localPath(key);
  const fileStat = await stat(filePath);
  if (fileStat.size <= 0) {
    throw new Error(`Prepared image is empty: ${key}`);
  }

  const metadata = await sharp(await readFile(filePath)).metadata();
  if (
    metadata.width === undefined ||
    metadata.height === undefined ||
    Math.max(metadata.width, metadata.height) > maxEdge ||
    metadata.format !== expectedFormat
  ) {
    throw new Error(
      `Prepared image verification failed: ${key} (${String(metadata.width)}x${String(metadata.height)}, ${String(metadata.format)})`,
    );
  }
};

const preparePhotoImage = async (
  item: MediaItem,
  storage: StorageAdapter,
  key: string,
  maxEdge: number,
  format: "jpeg" | "webp",
  quality: number,
  onLog: ((message: string) => void) | undefined,
): Promise<void> => {
  const input = await imageInput(item, onLog);
  const pipeline = sharp(input).rotate().resize({
    fit: "inside",
    height: maxEdge,
    width: maxEdge,
    withoutEnlargement: true,
  });
  const output =
    format === "webp"
      ? await pipeline.webp({quality}).toBuffer()
      : await pipeline.jpeg({quality}).toBuffer();
  await storage.write(key, output);
  await verifyImage(storage, key, maxEdge, format);
};

const seekTime = (durationSec: number, fraction: number): string =>
  Math.max(0, Math.min(Math.max(0, durationSec - 0.001), durationSec * fraction)).toFixed(3);

const extractVideoFrame = async (
  item: MediaItem,
  fraction: number,
  outputPath: string,
  transcoder: MediaTranscoder,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const durationSec = item.video?.durationSec ?? 0.001;
  await transcoder.run(
    [
      "-y",
      "-ss",
      seekTime(durationSec, fraction),
      "-i",
      item.absolutePath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-an",
      outputPath,
    ],
    {signal},
  );
};

const prepareVideoThumb = async (
  item: MediaItem,
  storage: StorageAdapter,
  key: string,
  transcoder: MediaTranscoder,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "travel-thumb-"));
  try {
    const framePath = path.join(temporaryRoot, "frame.png");
    await extractVideoFrame(item, 0.5, framePath, transcoder, signal);
    const output = await sharp(framePath)
      .resize({
        fit: "inside",
        height: THUMB_MAX_EDGE,
        width: THUMB_MAX_EDGE,
        withoutEnlargement: true,
      })
      .webp({quality: 72})
      .toBuffer();
    await storage.write(key, output);
    await verifyImage(storage, key, THUMB_MAX_EDGE, "webp");
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true});
  }
};

const prepareVideoAnalysis = async (
  item: MediaItem,
  storage: StorageAdapter,
  key: string,
  transcoder: MediaTranscoder,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "travel-analysis-"));
  try {
    const framePaths = [0, 1, 2].map((index) => path.join(temporaryRoot, `frame-${index}.png`));
    for (const [index, fraction] of [0.25, 0.5, 0.75].entries()) {
      await extractVideoFrame(item, fraction, framePaths[index]!, transcoder, signal);
    }

    const cellWidths = [342, 341, 341];
    const aspect = item.width / item.height;
    const cellHeight = Math.max(1, Math.min(ANALYSIS_MAX_EDGE, Math.round(341 / aspect)));
    const cells = await Promise.all(
      framePaths.map((framePath, index) =>
        sharp(framePath).resize(cellWidths[index]!, cellHeight, {fit: "cover"}).png().toBuffer(),
      ),
    );
    const output = await sharp({
      create: {
        background: "black",
        channels: 3,
        height: cellHeight,
        width: ANALYSIS_MAX_EDGE,
      },
    })
      .composite([
        {input: cells[0]!, left: 0, top: 0},
        {input: cells[1]!, left: cellWidths[0]!, top: 0},
        {input: cells[2]!, left: cellWidths[0]! + cellWidths[1]!, top: 0},
      ])
      .jpeg({quality: 82})
      .toBuffer();
    await storage.write(key, output);
    await verifyImage(storage, key, ANALYSIS_MAX_EDGE, "jpeg");
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true});
  }
};

const parseNumber = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const videoDetails = (
  output: FfprobeOutput,
): {
  readonly durationSec: number;
  readonly height: number;
  readonly rotation: number;
  readonly width: number;
} => {
  const stream = output.streams?.find((candidate) => candidate.codec_type === "video");
  const durationSec =
    parseNumber(output.format?.duration) ?? parseNumber(stream?.duration) ?? Number.NaN;
  const rotation =
    stream?.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ??
    parseNumber(stream?.tags?.rotate) ??
    0;
  if (
    stream?.width === undefined ||
    stream.height === undefined ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0
  ) {
    throw new Error("Prepared proxy ffprobe metadata is incomplete");
  }
  return {durationSec, height: stream.height, rotation, width: stream.width};
};

const verifyProxy = async (
  item: MediaItem,
  storage: StorageAdapter,
  key: string,
  probe: MediaProbe,
  maxWidth: number = VIDEO_PROXY_MAX_WIDTH,
): Promise<void> => {
  const filePath = await storage.localPath(key);
  const fileStat = await stat(filePath);
  if (fileStat.size <= 0) {
    throw new Error(`Prepared video proxy is empty: ${key}`);
  }

  const details = videoDetails(await probe.probe(filePath));
  const sourceDuration = item.video?.durationSec ?? 0;
  const sourceIsPortrait = item.height > item.width;
  const outputIsPortrait = details.height > details.width;
  if (
    details.width > maxWidth ||
    Math.abs(details.durationSec - sourceDuration) > 0.5 ||
    (item.width === item.height && details.width !== details.height) ||
    (item.width !== item.height && sourceIsPortrait !== outputIsPortrait) ||
    Math.abs(details.rotation % 360) > 0.001
  ) {
    throw new Error(
      `Prepared proxy verification failed: ${key} (${details.width}x${details.height}, duration ${details.durationSec}, rotation ${details.rotation})`,
    );
  }
};

const prepareVideoProxy = async (
  item: MediaItem,
  storage: StorageAdapter,
  key: string,
  transcoder: MediaTranscoder,
  probe: MediaProbe,
  signal: AbortSignal | undefined,
  options: {readonly crf: number; readonly maxFps: number; readonly maxWidth: number} = {
    crf: 26,
    maxFps: 30,
    maxWidth: VIDEO_PROXY_MAX_WIDTH,
  },
): Promise<void> => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "travel-proxy-"));
  try {
    const temporaryOutput = path.join(temporaryRoot, "proxy.mp4");
    const fps = Math.min(options.maxFps, item.video?.fps ?? 30);
    await transcoder.run(
      [
        "-y",
        "-i",
        item.absolutePath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-map_metadata",
        "-1",
        "-vf",
        `scale=w='max(2,trunc(min(${String(options.maxWidth)},iw)/2)*2)':h=-2:flags=lanczos,fps=${fps.toFixed(3)}`,
        "-c:v",
        "libx264",
        "-crf",
        String(options.crf),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        temporaryOutput,
      ],
      {signal},
    );
    await storage.write(key, createReadStream(temporaryOutput));
    await verifyProxy(item, storage, key, probe, options.maxWidth);
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true});
  }
};

const executeStage = async (
  item: MediaItem,
  stage: PrepareStage,
  plan: StagePlan,
  options: PrepareOptions,
  dependencies: PrepareDependencies,
): Promise<void> => {
  if (stage === "thumb") {
    if (item.mediaType === "photo") {
      await preparePhotoImage(
        item,
        dependencies.storage,
        plan.outputKeys[0]!,
        THUMB_MAX_EDGE,
        "webp",
        72,
        dependencies.onLog,
      );
    } else {
      await prepareVideoThumb(
        item,
        dependencies.storage,
        plan.outputKeys[0]!,
        dependencies.transcoder,
        options.signal,
      );
    }
    return;
  }

  if (stage === "analysis") {
    if (item.mediaType === "photo") {
      await preparePhotoImage(
        item,
        dependencies.storage,
        plan.outputKeys[0]!,
        ANALYSIS_MAX_EDGE,
        "jpeg",
        82,
        dependencies.onLog,
      );
    } else {
      await prepareVideoAnalysis(
        item,
        dependencies.storage,
        plan.outputKeys[0]!,
        dependencies.transcoder,
        options.signal,
      );
      await prepareVideoProxy(
        item,
        dependencies.storage,
        plan.outputKeys[1]!,
        dependencies.transcoder,
        dependencies.probe,
        options.signal,
      );
    }
    return;
  }

  if (item.mediaType === "video") {
    await prepareVideoProxy(
      item,
      dependencies.storage,
      plan.outputKeys[0]!,
      dependencies.transcoder,
      dependencies.probe,
      options.signal,
      {crf: 20, maxFps: 60, maxWidth: options.renderTargetLongEdgePx ?? 1920},
    );
    return;
  }

  const maxEdge = Math.round((options.renderTargetLongEdgePx ?? 1920) * 1.4);
  await preparePhotoImage(
    item,
    dependencies.storage,
    plan.outputKeys[0]!,
    maxEdge,
    "jpeg",
    90,
    dependencies.onLog,
  );
};

const parseStages = (stages: readonly PrepareStage[] | undefined): PrepareStage[] => {
  const unique = [...new Set(stages ?? (["thumb", "analysis"] as const))];
  if (unique.length === 0) {
    throw new Error("At least one prepare stage is required");
  }
  return unique;
};

export const prepareMedia = async (
  inputIndex: MediaIndex,
  options: PrepareOptions,
  dependencies: PrepareDependencies,
): Promise<PrepareResult> => {
  const index = mediaIndexSchema.parse(inputIndex);
  const stages = parseStages(options.stages);
  const renderTargetLongEdgePx = options.renderTargetLongEdgePx ?? 1920;
  if (!Number.isInteger(renderTargetLongEdgePx) || renderTargetLongEdgePx <= 0) {
    throw new RangeError("renderTargetLongEdgePx must be a positive integer");
  }
  if (
    stages.includes("render") &&
    (options.mediaIds === undefined || options.mediaIds.length === 0)
  ) {
    throw new Error("The render stage requires explicit selected mediaIds");
  }

  const concurrency = dependencies.concurrency ?? cpus().length;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError("concurrency must be a positive integer");
  }

  const requestedIds = options.mediaIds === undefined ? null : new Set(options.mediaIds);
  if (requestedIds !== null) {
    const knownIds = new Set(index.items.map((item) => item.id));
    const missing = [...requestedIds].filter((id) => !knownIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Unknown mediaIds: ${missing.join(", ")}`);
    }
  }
  const selectedItems = index.items.filter(
    (item) => requestedIds === null || requestedIds.has(item.id),
  );
  const patches = new Map<string, ArtifactPatch>();
  const tasks = stages.flatMap((stage) => selectedItems.map((item) => ({item, stage})));
  const totalOperations = tasks.length;
  let completed = 0;
  let cacheHits = 0;
  let processed = 0;

  const runTask = async ({item, stage}: (typeof tasks)[number]): Promise<void> => {
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new Error("Prepare operation was aborted");
    }

    const plan = getStagePlan(item, stage, renderTargetLongEdgePx);
    const hit = options.force !== true && (await isCacheHit(dependencies.storage, plan));
    if (hit) {
      cacheHits += 1;
    } else {
      await executeStage(item, stage, plan, options, dependencies);
      await writeCacheRecord(dependencies.storage, item, stage, plan);
      processed += 1;
    }
    patches.set(item.id, {...patches.get(item.id), ...plan.patch});
    completed += 1;
    dependencies.onProgress?.({
      completed,
      mediaId: item.id,
      progress: totalOperations === 0 ? 1 : completed / totalOperations,
      stage,
      total: totalOperations,
    });
  };

  const memoryPressure = process.memoryUsage().rss >= totalmem() * 0.75;
  const largeTasks = tasks.filter(({item}) => item.fileSize >= LARGE_FILE_BYTES);
  const regularTasks = tasks.filter(({item}) => item.fileSize < LARGE_FILE_BYTES);
  const effectiveConcurrency = memoryPressure
    ? Math.max(1, Math.floor(concurrency / 2))
    : concurrency;
  if (memoryPressure) {
    dependencies.onLog?.(
      `Memory pressure detected (rss ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB): reducing concurrency ${String(concurrency)} → ${String(effectiveConcurrency)}`,
    );
  }
  const limit = pLimit(effectiveConcurrency);
  await Promise.all(regularTasks.map((task) => limit(() => runTask(task))));
  if (largeTasks.length > 0) {
    dependencies.onLog?.(
      `Prepare sequential fallback: ${String(largeTasks.length)} large file(s) ≥ ${String(LARGE_FILE_BYTES / 1024 / 1024)}MB will run sequentially`,
    );
  }
  for (const task of largeTasks) {
    await runTask(task);
  }

  const outputIndex = mediaIndexSchema.parse({
    ...index,
    items: index.items.map((item) => ({...item, ...patches.get(item.id)})),
  });
  const manifestKey = dependencies.manifestKey ?? DEFAULT_MEDIA_MANIFEST_KEY;
  await persistMediaIndex(dependencies.database, dependencies.storage, outputIndex, manifestKey);

  return {
    index: outputIndex,
    manifestKey,
    statistics: {
      cacheHits,
      completedOperations: completed,
      largeFilesSequential: largeTasks.length,
      processed,
      selectedMedia: selectedItems.length,
      totalOperations,
    },
  };
};
