import {createHash} from "node:crypto";
import {cpus} from "node:os";

import type BetterSqlite3 from "better-sqlite3";
import pLimit from "p-limit";
import sharp from "sharp";

import {clusterByTimeAndHash, dhashFromGrayscale, percentileRanks} from "@travel-movie/core";
import {mediaIndexSchema, type MediaIndex, type MediaItem} from "@travel-movie/schema";

import {DEFAULT_MEDIA_MANIFEST_KEY, persistMediaIndex} from "../services/media-index.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";

export const FINGERPRINT_CODE_VERSION = 1;

const CACHE_ROOT = "cache/fingerprint";
const BLURRY_ISSUE = "blurry";

export interface FingerprintOptions {
  readonly force?: boolean;
  readonly maxGapSec?: number;
  readonly maxHamming?: number;
}

export interface FingerprintProgress {
  readonly completed: number;
  readonly mediaId: string;
  readonly progress: number;
  readonly total: number;
}

export interface FingerprintDependencies {
  readonly concurrency?: number;
  readonly database: BetterSqlite3.Database;
  readonly manifestKey?: string;
  readonly onLog?: (message: string) => void;
  readonly onProgress?: (progress: FingerprintProgress) => void;
  readonly storage: StorageAdapter;
}

export interface FingerprintStatistics {
  readonly blurry: number;
  readonly cacheHits: number;
  readonly clusters: number;
  readonly processed: number;
  readonly selectionCandidates: number;
  readonly suppressedPhotos: number;
}

export interface FingerprintResult {
  readonly index: MediaIndex;
  readonly manifestKey: string;
  readonly statistics: FingerprintStatistics;
}

export interface ImageFingerprintMetrics {
  readonly blurVariance: number;
  readonly dhash: string | null;
  readonly exposureQuality: number;
}

interface FingerprintCacheRecord extends ImageFingerprintMetrics {
  readonly cacheKey: string;
  readonly codeVersion: number;
  readonly createdAt: string;
  readonly mediaId: string;
}

interface MeasuredItem {
  readonly item: MediaItem;
  readonly metrics: ImageFingerprintMetrics;
}

const makeCacheKey = (analysisHash: string, photo: boolean): string =>
  createHash("sha1")
    .update(
      ["fingerprint:metrics", FINGERPRINT_CODE_VERSION, analysisHash, JSON.stringify({photo})].join(
        "|",
      ),
    )
    .digest("hex");

export const calculateImageFingerprint = async (
  input: Buffer,
  photo: boolean,
): Promise<ImageFingerprintMetrics> => {
  const grayscale = sharp(input).greyscale().resize(512, 512, {
    fit: "inside",
    withoutEnlargement: false,
  });
  const [blurStats, exposurePixels, hashPixels] = await Promise.all([
    grayscale
      .clone()
      .convolve({height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], width: 3})
      .stats(),
    grayscale.clone().raw().toBuffer({resolveWithObject: true}),
    photo
      ? sharp(input)
          .greyscale()
          .resize(9, 8, {fit: "fill"})
          .raw()
          .toBuffer({resolveWithObject: true})
      : Promise.resolve(null),
  ]);
  const stdev = blurStats.channels[0]?.stdev;
  if (stdev === undefined || !Number.isFinite(stdev)) {
    throw new Error("Sharp did not return a valid Laplacian standard deviation");
  }

  let clipped = 0;
  for (const value of exposurePixels.data) {
    if (value <= 4 || value >= 251) {
      clipped += 1;
    }
  }
  const exposureQuality = 1 - clipped / exposurePixels.data.length;

  return {
    blurVariance: stdev ** 2,
    dhash: hashPixels === null ? null : dhashFromGrayscale(hashPixels.data),
    exposureQuality,
  };
};

const readCacheRecord = async (
  storage: StorageAdapter,
  key: string,
): Promise<FingerprintCacheRecord | null> => {
  try {
    const parsed = JSON.parse(
      (await storage.read(key)).toString("utf8"),
    ) as Partial<FingerprintCacheRecord>;
    if (
      typeof parsed.cacheKey !== "string" ||
      parsed.codeVersion !== FINGERPRINT_CODE_VERSION ||
      typeof parsed.blurVariance !== "number" ||
      !Number.isFinite(parsed.blurVariance) ||
      typeof parsed.exposureQuality !== "number" ||
      !Number.isFinite(parsed.exposureQuality) ||
      (parsed.dhash !== null &&
        (typeof parsed.dhash !== "string" || !/^[0-9a-f]{16}$/u.test(parsed.dhash)))
    ) {
      return null;
    }
    return parsed as FingerprintCacheRecord;
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

const measureItem = async (
  item: MediaItem,
  force: boolean,
  storage: StorageAdapter,
): Promise<{readonly cacheHit: boolean; readonly measured: MeasuredItem}> => {
  if (item.analysisKey === null) {
    throw new Error(`Media ${item.id} has no analysisKey. Run prepare analysis first.`);
  }
  const input = await storage.read(item.analysisKey);
  const analysisHash = createHash("sha1").update(input).digest("hex");
  const cacheKey = makeCacheKey(analysisHash, item.mediaType === "photo");
  const cacheRecordKey = `${CACHE_ROOT}/${item.id}.json`;
  const cached = force ? null : await readCacheRecord(storage, cacheRecordKey);
  if (cached?.cacheKey === cacheKey) {
    return {
      cacheHit: true,
      measured: {
        item,
        metrics: {
          blurVariance: cached.blurVariance,
          dhash: cached.dhash,
          exposureQuality: cached.exposureQuality,
        },
      },
    };
  }

  const metrics = await calculateImageFingerprint(input, item.mediaType === "photo");
  const record: FingerprintCacheRecord = {
    ...metrics,
    cacheKey,
    codeVersion: FINGERPRINT_CODE_VERSION,
    createdAt: new Date().toISOString(),
    mediaId: item.id,
  };
  await storage.write(cacheRecordKey, Buffer.from(JSON.stringify(record, null, 2)));
  return {cacheHit: false, measured: {item, metrics}};
};

const localTimestamp = (value: string): number => {
  const parsed = Date.parse(`${value}Z`);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid capturedAtLocal: ${value}`);
  }
  return parsed;
};

const centerWeight = (cluster: readonly MediaItem[], item: MediaItem): number => {
  const times = cluster.map((entry) => localTimestamp(entry.capturedAtLocal));
  const first = Math.min(...times);
  const last = Math.max(...times);
  if (first === last) {
    return 1;
  }
  const middle = (first + last) / 2;
  return 1 - Math.abs(localTimestamp(item.capturedAtLocal) - middle) / ((last - first) / 2);
};

const selectBest = (cluster: readonly MediaItem[]): string | null => {
  const included = cluster.filter((item) => item.userDecision === "include");
  const eligible = cluster.filter((item) => item.userDecision !== "exclude");
  const candidates = included.length > 0 ? included : eligible;
  return (
    [...candidates].sort((left, right) => {
      const leftScore =
        0.45 * (left.blurScore ?? 0) +
        0.2 * (left.exposureScore ?? 0) +
        0.15 * centerWeight(cluster, left);
      const rightScore =
        0.45 * (right.blurScore ?? 0) +
        0.2 * (right.exposureScore ?? 0) +
        0.15 * centerWeight(cluster, right);
      return (
        rightScore - leftScore ||
        left.capturedAtLocal.localeCompare(right.capturedAtLocal) ||
        left.id.localeCompare(right.id)
      );
    })[0]?.id ?? null
  );
};

const applyBlurryIssue = (
  item: MediaItem,
  blurScore: number,
): Pick<MediaItem, "issues" | "status"> => {
  const withoutBlurry = item.issues.filter((issue) => issue !== BLURRY_ISSUE);
  const blurry = blurScore <= 0.1;
  const issues = blurry ? [...withoutBlurry, BLURRY_ISSUE] : withoutBlurry;
  const wasOnlyBlurryWarning =
    item.status === "warning" &&
    item.issues.length > 0 &&
    item.issues.every((issue) => issue === BLURRY_ISSUE);
  const status =
    item.status === "error"
      ? "error"
      : blurry
        ? "warning"
        : wasOnlyBlurryWarning
          ? "ok"
          : item.status;
  return {issues, status};
};

export const fingerprintMedia = async (
  inputIndex: MediaIndex,
  options: FingerprintOptions,
  dependencies: FingerprintDependencies,
): Promise<FingerprintResult> => {
  const index = mediaIndexSchema.parse(inputIndex);
  const maxGapSec = options.maxGapSec ?? 45;
  const maxHamming = options.maxHamming ?? 10;
  if (!Number.isFinite(maxGapSec) || maxGapSec < 0) {
    throw new RangeError("maxGapSec must be a finite nonnegative number");
  }
  if (!Number.isInteger(maxHamming) || maxHamming < 0 || maxHamming > 64) {
    throw new RangeError("maxHamming must be an integer between 0 and 64");
  }
  const concurrency = dependencies.concurrency ?? cpus().length;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError("concurrency must be a positive integer");
  }

  const limit = pLimit(concurrency);
  let completed = 0;
  let cacheHits = 0;
  const measured = await Promise.all(
    index.items.map((item) =>
      limit(async () => {
        const result = await measureItem(item, options.force === true, dependencies.storage);
        if (result.cacheHit) {
          cacheHits += 1;
        }
        completed += 1;
        dependencies.onProgress?.({
          completed,
          mediaId: item.id,
          progress: index.items.length === 0 ? 1 : completed / index.items.length,
          total: index.items.length,
        });
        return result.measured;
      }),
    ),
  );

  const blurScores = percentileRanks(measured.map(({metrics}) => metrics.blurVariance));
  const exposureScores = percentileRanks(measured.map(({metrics}) => metrics.exposureQuality));
  const scoredItems = measured.map(({item, metrics}, position): MediaItem => {
    const blurScore = blurScores[position]!;
    const exposureScore = exposureScores[position]!;
    return {
      ...item,
      ...applyBlurryIssue(item, blurScore),
      blurScore,
      dhash: metrics.dhash,
      exposureScore,
      isClusterBest: item.mediaType === "video",
      clusterId: null,
    };
  });

  const photos = scoredItems.filter(
    (item): item is MediaItem & {dhash: string} =>
      item.mediaType === "photo" && item.dhash !== null,
  );
  const clusters = clusterByTimeAndHash(photos, {maxGapSec, maxHamming});
  const clusterIdByMedia = new Map<string, string>();
  const bestIds = new Set<string>();
  for (const cluster of clusters) {
    const clusterId = `k_${createHash("sha1")
      .update(cluster.map((item) => item.id).join("|"))
      .digest("hex")
      .slice(0, 8)}`;
    for (const item of cluster) {
      clusterIdByMedia.set(item.id, clusterId);
    }
    const bestId = selectBest(cluster);
    if (bestId !== null) {
      bestIds.add(bestId);
    }
  }

  const outputIndex = mediaIndexSchema.parse({
    ...index,
    items: scoredItems.map((item) =>
      item.mediaType === "photo"
        ? {
            ...item,
            clusterId: clusterIdByMedia.get(item.id) ?? null,
            isClusterBest: bestIds.has(item.id),
          }
        : item,
    ),
  });
  const manifestKey = dependencies.manifestKey ?? DEFAULT_MEDIA_MANIFEST_KEY;
  await persistMediaIndex(dependencies.database, dependencies.storage, outputIndex, manifestKey);

  const blurry = outputIndex.items.filter((item) => item.issues.includes(BLURRY_ISSUE)).length;
  const suppressedPhotos = outputIndex.items.filter(
    (item) => item.mediaType === "photo" && !item.isClusterBest && item.userDecision !== "include",
  ).length;
  const selectionCandidates = outputIndex.items.filter((item) => {
    if (item.userDecision === "exclude") {
      return false;
    }
    if (item.userDecision === "include") {
      return true;
    }
    if (item.livePhoto?.role === "motion" || item.issues.includes(BLURRY_ISSUE)) {
      return false;
    }
    return item.mediaType === "video" || item.isClusterBest;
  }).length;
  dependencies.onLog?.(
    `Fingerprint: ${String(clusters.length)} clusters, ${String(suppressedPhotos)} suppressed photos, ${String(blurry)} blurry`,
  );

  return {
    index: outputIndex,
    manifestKey,
    statistics: {
      blurry,
      cacheHits,
      clusters: clusters.length,
      processed: measured.length - cacheHits,
      selectionCandidates,
      suppressedPhotos,
    },
  };
};
