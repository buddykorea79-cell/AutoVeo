import {createHash} from "node:crypto";
import {open, readFile, readdir, realpath, stat} from "node:fs/promises";
import {cpus} from "node:os";
import path from "node:path";

import type BetterSqlite3 from "better-sqlite3";
import exifr from "exifr";
import convertHeic from "heic-convert";
import pLimit from "p-limit";
import sharp from "sharp";

import {
  mediaIndexSchema,
  type Gps,
  type MediaIndex,
  type MediaItem,
  type TimeSource,
} from "@travel-movie/schema";

import type {FfprobeOutput, MediaProbe} from "../services/ffprobe.js";
import {DEFAULT_MEDIA_MANIFEST_KEY, persistMediaIndex} from "../services/media-index.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";

const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "heif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "mkv", "avi"]);
const LIVE_PHOTO_STILL_EXTENSIONS = new Set(["jpg", "jpeg", "heic", "heif"]);
const HASH_CHUNK_BYTES = 256 * 1024;

export interface PhotoMetadata {
  readonly dateTimeOriginal: Date | string | null;
  readonly gps: Gps | null;
  readonly offsetTimeOriginal: string | null;
  readonly orientation: number | null;
}

export interface PhotoMetadataReader {
  read(filePath: string): Promise<PhotoMetadata>;
}

export class ExifrPhotoMetadataReader implements PhotoMetadataReader {
  async read(filePath: string): Promise<PhotoMetadata> {
    const tags = (await exifr.parse(filePath, {
      exif: true,
      gps: true,
      reviveValues: false,
      tiff: true,
      translateValues: false,
    })) as Record<string, unknown> | undefined;
    const altitude = tags?.GPSAltitude;
    const latitude = tags?.latitude;
    const longitude = tags?.longitude;
    const hasGps =
      typeof latitude === "number" &&
      Number.isFinite(latitude) &&
      typeof longitude === "number" &&
      Number.isFinite(longitude);

    return {
      dateTimeOriginal:
        tags?.DateTimeOriginal instanceof Date || typeof tags?.DateTimeOriginal === "string"
          ? tags.DateTimeOriginal
          : null,
      gps: hasGps
        ? {
            alt: typeof altitude === "number" && Number.isFinite(altitude) ? altitude : null,
            lat: latitude,
            lon: longitude,
          }
        : null,
      offsetTimeOriginal:
        typeof tags?.OffsetTimeOriginal === "string" ? tags.OffsetTimeOriginal : null,
      orientation:
        typeof tags?.Orientation === "number" && Number.isInteger(tags.Orientation)
          ? tags.Orientation
          : null,
    };
  }
}

export interface ScanProgress {
  readonly completed: number;
  readonly currentPath: string;
  readonly progress: number;
  readonly total: number;
}

export interface ScanStatistics {
  readonly errors: number;
  readonly estimatedUtcOffsetMin: number;
  readonly heic: number;
  readonly heicDecoder: "heic-convert";
  readonly livePhotoPairs: number;
  readonly mp4UtcConvertedCount: number;
  readonly photos: number;
  readonly timeSources: Record<TimeSource, number>;
  readonly total: number;
  readonly videos: number;
}

export interface ScanDependencies {
  readonly concurrency?: number;
  readonly database: BetterSqlite3.Database;
  readonly manifestKey?: string;
  readonly mediaFilter?: "all" | "photo" | "video";
  readonly onLog?: (message: string) => void;
  readonly onProgress?: (progress: ScanProgress) => void;
  readonly photoMetadataReader?: PhotoMetadataReader;
  readonly probe: MediaProbe;
  readonly projectUtcOffsetMin?: number;
  readonly storage: StorageAdapter;
}

export interface ScanResult {
  readonly index: MediaIndex;
  readonly manifestKey: string;
  readonly statistics: ScanStatistics;
}

interface DiscoveredFile {
  readonly absolutePath: string;
  readonly ext: string;
  readonly mediaType: "photo" | "video";
  readonly relativePath: string;
}

interface PhotoDetails {
  readonly height: number;
  readonly metadata: PhotoMetadata | null;
  readonly orientationTag: number | null;
  readonly width: number;
}

interface RawMedia extends DiscoveredFile {
  readonly contentHash: string;
  readonly fileSize: number;
  readonly issues: string[];
  readonly modifiedAt: Date;
  readonly photo: PhotoDetails | null;
  readonly probe: FfprobeOutput | null;
}

export interface NormalizedCaptureTime {
  readonly capturedAtLocal: string;
  readonly timeSource: TimeSource;
  readonly utcOffsetMin: number | null;
}

const pad = (value: number, length = 2): string => String(value).padStart(length, "0");

const formatLocalDate = (value: Date): string =>
  `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` +
  `T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;

const formatUtcComponents = (value: Date): string =>
  `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}` +
  `T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;

const parseOffsetMinutes = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (value === "Z") {
    return 0;
  }

  const match = /^([+-])(\d{2}):?(\d{2})$/u.exec(value);
  if (match === null) {
    return null;
  }

  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59) {
    return null;
  }

  const sign = match[1] === "-" ? -1 : 1;
  return sign * (hours * 60 + minutes);
};

const normalizeExifDate = (value: Date | string | null): string | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatLocalDate(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(value);
  return match === null
    ? null
    : `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
};

const parseTaggedDate = (
  value: string,
): {readonly capturedAtLocal: string; readonly utcOffsetMin: number | null} | null => {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/u.exec(
    value,
  );
  if (match === null) {
    return null;
  }

  return {
    capturedAtLocal: `${match[1]}T${match[2]}`,
    utcOffsetMin: parseOffsetMinutes(match[3]),
  };
};

export const normalizePhotoCaptureTime = (
  metadata: PhotoMetadata | null,
  modifiedAt: Date,
): NormalizedCaptureTime => {
  const capturedAtLocal = normalizeExifDate(metadata?.dateTimeOriginal ?? null);
  if (capturedAtLocal !== null) {
    const utcOffsetMin = parseOffsetMinutes(metadata?.offsetTimeOriginal);
    return {
      capturedAtLocal,
      timeSource: utcOffsetMin === null ? "exif-naive" : "exif-with-offset",
      utcOffsetMin,
    };
  }

  return {
    capturedAtLocal: formatLocalDate(modifiedAt),
    timeSource: "filesystem",
    utcOffsetMin: -modifiedAt.getTimezoneOffset(),
  };
};

const findTag = (tags: Record<string, string> | undefined, name: string): string | undefined => {
  if (tags === undefined) {
    return undefined;
  }

  const entry = Object.entries(tags).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
};

export const normalizeVideoCaptureTime = (
  probe: FfprobeOutput | null,
  modifiedAt: Date,
  projectUtcOffsetMin: number,
): NormalizedCaptureTime => {
  const quickTimeValue = findTag(probe?.format?.tags, "com.apple.quicktime.creationdate");
  if (quickTimeValue !== undefined) {
    const tagged = parseTaggedDate(quickTimeValue);
    if (tagged !== null) {
      return {...tagged, timeSource: "quicktime-local"};
    }
  }

  const creationTime = findTag(probe?.format?.tags, "creation_time");
  if (creationTime !== undefined) {
    const utc = new Date(creationTime);
    if (!Number.isNaN(utc.getTime())) {
      const shifted = new Date(utc.getTime() + projectUtcOffsetMin * 60_000);
      return {
        capturedAtLocal: formatUtcComponents(shifted),
        timeSource: "mp4-utc-converted",
        utcOffsetMin: projectUtcOffsetMin,
      };
    }
  }

  return {
    capturedAtLocal: formatLocalDate(modifiedAt),
    timeSource: "filesystem",
    utcOffsetMin: -modifiedAt.getTimezoneOffset(),
  };
};

export const inferProjectUtcOffset = (
  offsets: readonly number[],
  fallbackOffsetMin: number,
): number => {
  const counts = new Map<number, number>();
  for (const offset of offsets) {
    counts.set(offset, (counts.get(offset) ?? 0) + 1);
  }

  return (
    [...counts.entries()].sort(
      ([leftOffset, leftCount], [rightOffset, rightCount]) =>
        rightCount - leftCount || leftOffset - rightOffset,
    )[0]?.[0] ?? fallbackOffsetMin
  );
};

export const computePartialHash = async (filePath: string, fileSize: number): Promise<string> => {
  const hash = createHash("sha1");
  hash.update(String(fileSize));
  const handle = await open(filePath, "r");

  try {
    const head = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, fileSize));
    if (head.length > 0) {
      const {bytesRead} = await handle.read(head, 0, head.length, 0);
      hash.update(head.subarray(0, bytesRead));
    }

    if (fileSize > HASH_CHUNK_BYTES * 2) {
      const tail = Buffer.alloc(HASH_CHUNK_BYTES);
      const {bytesRead} = await handle.read(tail, 0, tail.length, fileSize - HASH_CHUNK_BYTES);
      hash.update(tail.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }

  return hash.digest("hex").slice(0, 12);
};

const discoverMedia = async (
  sourceRoot: string,
  filter: "all" | "photo" | "video" = "all",
): Promise<DiscoveredFile[]> => {
  const discovered: DiscoveredFile[] = [];
  const canonicalRoot = await realpath(sourceRoot);
  const visitedDirectories = new Set<string>();

  const isInsideSourceRoot = (candidate: string): boolean => {
    const relative = path.relative(canonicalRoot, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const visit = async (directory: string): Promise<void> => {
    const canonicalDirectory = await realpath(directory);
    if (!isInsideSourceRoot(canonicalDirectory) || visitedDirectories.has(canonicalDirectory)) {
      return;
    }
    visitedDirectories.add(canonicalDirectory);
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const canonicalEntry = await realpath(absolutePath);
          if (!isInsideSourceRoot(canonicalEntry)) {
            continue;
          }
          const followed = await stat(absolutePath);
          isDirectory = followed.isDirectory();
          isFile = followed.isFile();
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        await visit(absolutePath);
        continue;
      }

      if (!isFile) {
        continue;
      }

      const ext = path.extname(entry.name).slice(1).toLowerCase();
      const mediaType = PHOTO_EXTENSIONS.has(ext)
        ? "photo"
        : VIDEO_EXTENSIONS.has(ext)
          ? "video"
          : null;

      if (mediaType === null) {
        continue;
      }
      if (filter === "photo" && mediaType !== "photo") {
        continue;
      }
      if (filter === "video" && mediaType !== "video") {
        continue;
      }
      discovered.push({
        absolutePath,
        ext,
        mediaType,
        relativePath: path.relative(sourceRoot, absolutePath),
      });
    }
  };

  await visit(sourceRoot);
  return discovered;
};

export const hashMediaFolderSnapshot = async (
  sourceRoot: string,
  filter: "all" | "photo" | "video" = "all",
): Promise<string> => {
  if (!path.isAbsolute(sourceRoot)) {
    throw new Error("Media sourceRoot must be an absolute path");
  }
  const sourceStat = await stat(sourceRoot);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Media sourceRoot is not a directory: ${sourceRoot}`);
  }

  const discovered = await discoverMedia(sourceRoot, filter);
  if (discovered.length === 0) {
    throw new Error(
      "선택한 폴더에서 지원되는 사진이나 영상을 찾지 못했습니다. JPG, JPEG, PNG, HEIC, HEIF, MP4, MOV 또는 M4V 파일이 있는 폴더를 선택하세요.",
    );
  }
  const hash = createHash("sha1");
  for (const file of discovered) {
    const fileStat = await stat(file.absolutePath);
    hash.update(file.relativePath);
    hash.update("|");
    hash.update(String(fileStat.size));
    hash.update("|");
    hash.update(String(Math.trunc(fileStat.mtimeMs)));
    hash.update("\n");
  }
  return hash.digest("hex");
};

const readPhotoDimensions = async (
  file: DiscoveredFile,
  onLog: ((message: string) => void) | undefined,
): Promise<{height: number; orientation: number | null; width: number}> => {
  const image =
    file.ext === "heic" || file.ext === "heif"
      ? await (async () => {
          onLog?.(`HEIC decoder: heic-convert -> sharp (${file.relativePath})`);
          const converted = await convertHeic({
            buffer: await readFile(file.absolutePath),
            format: "JPEG",
            quality: 1,
          });
          return sharp(Buffer.from(converted));
        })()
      : sharp(file.absolutePath);
  const metadata = await image.metadata();

  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error("Image dimensions are missing");
  }

  return {
    height: metadata.height,
    orientation: metadata.orientation ?? null,
    width: metadata.width,
  };
};

const readRawMedia = async (
  file: DiscoveredFile,
  metadataReader: PhotoMetadataReader,
  probe: MediaProbe,
  onLog: ((message: string) => void) | undefined,
): Promise<RawMedia> => {
  const fileStat = await stat(file.absolutePath);
  const issues: string[] = [];
  let contentHash: string;

  try {
    contentHash = await computePartialHash(file.absolutePath, fileStat.size);
  } catch (error) {
    contentHash = createHash("sha1")
      .update(`${fileStat.size}|${file.relativePath}`)
      .digest("hex")
      .slice(0, 12);
    issues.push(`partial hash failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let photo: PhotoDetails | null = null;
  let probeOutput: FfprobeOutput | null = null;

  if (file.mediaType === "photo") {
    const [metadataResult, dimensionResult] = await Promise.allSettled([
      metadataReader.read(file.absolutePath),
      readPhotoDimensions(file, onLog),
    ]);
    const metadata = metadataResult.status === "fulfilled" ? metadataResult.value : null;
    const dimensions =
      dimensionResult.status === "fulfilled"
        ? dimensionResult.value
        : {height: 1, orientation: null, width: 1};

    if (metadataResult.status === "rejected") {
      issues.push(
        `EXIF read failed: ${metadataResult.reason instanceof Error ? metadataResult.reason.message : String(metadataResult.reason)}`,
      );
    }
    if (dimensionResult.status === "rejected") {
      issues.push(
        `image metadata failed: ${dimensionResult.reason instanceof Error ? dimensionResult.reason.message : String(dimensionResult.reason)}`,
      );
    }

    photo = {
      height: dimensions.height,
      metadata,
      orientationTag: metadata?.orientation ?? dimensions.orientation,
      width: dimensions.width,
    };
  } else {
    try {
      probeOutput = await probe.probe(file.absolutePath);
    } catch (error) {
      issues.push(`ffprobe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ...file,
    contentHash,
    fileSize: fileStat.size,
    issues,
    modifiedAt: fileStat.mtime,
    photo,
    probe: probeOutput,
  };
};

const parseFrameRate = (value: string | undefined): number => {
  if (value === undefined) {
    return 1;
  }
  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText ?? "1");
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : 1;
};

const readNumber = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};

const classifyOrientation = (width: number, height: number): MediaItem["orientation"] =>
  width === height ? "square" : width > height ? "landscape" : "portrait";

const buildPhotoItem = (raw: RawMedia): MediaItem => {
  const photo = raw.photo ?? {height: 1, metadata: null, orientationTag: null, width: 1};
  const swapsDimensions = [5, 6, 7, 8].includes(photo.orientationTag ?? 1);
  const width = swapsDimensions ? photo.height : photo.width;
  const height = swapsDimensions ? photo.width : photo.height;
  const capture = normalizePhotoCaptureTime(photo.metadata, raw.modifiedAt);

  return {
    absolutePath: raw.absolutePath,
    analysisKey: null,
    blurScore: null,
    capturedAtLocal: capture.capturedAtLocal,
    clusterId: null,
    contentHash: raw.contentHash,
    dhash: null,
    exposureScore: null,
    ext: raw.ext,
    filename: path.basename(raw.absolutePath),
    fileSize: raw.fileSize,
    gps: photo.metadata?.gps ?? null,
    height,
    id: `m_${raw.contentHash}`,
    isClusterBest: true,
    issues: raw.issues,
    livePhoto: null,
    mediaType: "photo",
    orientation: classifyOrientation(width, height),
    place: null,
    proxyKey: null,
    relativePath: raw.relativePath,
    renderAssetKey: null,
    rotationApplied: false,
    status: raw.issues.length === 0 ? "ok" : "error",
    thumbKey: null,
    timeSource: capture.timeSource,
    userDecision: "auto",
    utcOffsetMin: capture.utcOffsetMin,
    video: null,
    width,
  };
};

const buildVideoItem = (raw: RawMedia, projectUtcOffsetMin: number): MediaItem => {
  const issues = [...raw.issues];
  const streams = raw.probe?.streams ?? [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");

  if (videoStream === undefined) {
    issues.push("ffprobe output has no video stream");
  }

  const rawWidth = videoStream?.width ?? 1;
  const rawHeight = videoStream?.height ?? 1;
  const sideRotation = videoStream?.side_data_list
    ?.map((sideData) => sideData.rotation)
    .find((rotation): rotation is number => rotation !== undefined);
  const tagRotation = readNumber(findTag(videoStream?.tags, "rotate"));
  const rotation = sideRotation ?? tagRotation ?? 0;
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const swapsDimensions = normalizedRotation === 90 || normalizedRotation === 270;
  const width = swapsDimensions ? rawHeight : rawWidth;
  const height = swapsDimensions ? rawWidth : rawHeight;
  const durationSec =
    readNumber(videoStream?.duration) ?? readNumber(raw.probe?.format?.duration) ?? 0;
  if (durationSec <= 0) {
    issues.push("video duration is missing or zero");
  }

  const capture = normalizeVideoCaptureTime(raw.probe, raw.modifiedAt, projectUtcOffsetMin);

  return {
    absolutePath: raw.absolutePath,
    analysisKey: null,
    blurScore: null,
    capturedAtLocal: capture.capturedAtLocal,
    clusterId: null,
    contentHash: raw.contentHash,
    dhash: null,
    exposureScore: null,
    ext: raw.ext,
    filename: path.basename(raw.absolutePath),
    fileSize: raw.fileSize,
    gps: null,
    height,
    id: `m_${raw.contentHash}`,
    isClusterBest: true,
    issues,
    livePhoto: null,
    mediaType: "video",
    orientation: classifyOrientation(width, height),
    place: null,
    proxyKey: null,
    relativePath: raw.relativePath,
    renderAssetKey: null,
    rotationApplied: false,
    status: issues.length === 0 ? "ok" : "error",
    thumbKey: null,
    timeSource: capture.timeSource,
    userDecision: "auto",
    utcOffsetMin: capture.utcOffsetMin,
    video: {
      audioCodec: audioStream?.codec_name ?? null,
      bitrate: readNumber(videoStream?.bit_rate) ?? readNumber(raw.probe?.format?.bit_rate),
      durationSec: Math.max(durationSec, 0.001),
      fps: parseFrameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate),
      hasAudio: audioStream !== undefined,
      videoCodec: videoStream?.codec_name ?? "unknown",
    },
    width,
  };
};

const collectKnownOffsets = (rawItems: readonly RawMedia[]): number[] => {
  const offsets: number[] = [];

  for (const raw of rawItems) {
    if (raw.mediaType === "photo") {
      const local = normalizeExifDate(raw.photo?.metadata?.dateTimeOriginal ?? null);
      const offset = parseOffsetMinutes(raw.photo?.metadata?.offsetTimeOriginal);
      if (local !== null && offset !== null) {
        offsets.push(offset);
      }
      continue;
    }

    const quickTime = findTag(raw.probe?.format?.tags, "com.apple.quicktime.creationdate");
    if (quickTime !== undefined) {
      const offset = parseTaggedDate(quickTime)?.utcOffsetMin;
      if (offset !== null && offset !== undefined) {
        offsets.push(offset);
      }
    }
  }

  return offsets;
};

const pairLivePhotos = (
  items: readonly MediaItem[],
): {readonly items: MediaItem[]; readonly pairCount: number} => {
  const groups = new Map<string, MediaItem[]>();

  for (const item of items) {
    const key = `${path.dirname(item.relativePath).toLowerCase()}|${path.basename(item.relativePath, path.extname(item.relativePath)).toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const assignments = new Map<string, NonNullable<MediaItem["livePhoto"]>>();
  let pairCount = 0;

  for (const group of groups.values()) {
    const still = group.find(
      (item) => item.mediaType === "photo" && LIVE_PHOTO_STILL_EXTENSIONS.has(item.ext),
    );
    const motion = group.find(
      (item) =>
        item.mediaType === "video" &&
        item.ext === "mov" &&
        item.video !== null &&
        item.video.durationSec <= 4,
    );

    if (still === undefined || motion === undefined) {
      continue;
    }

    const pairId = `lp_${createHash("sha1")
      .update([still.id, motion.id].sort().join("|"))
      .digest("hex")
      .slice(0, 12)}`;
    assignments.set(still.relativePath, {pairId, role: "still"});
    assignments.set(motion.relativePath, {pairId, role: "motion"});
    pairCount += 1;
  }

  return {
    items: items.map((item) => ({
      ...item,
      livePhoto: assignments.get(item.relativePath) ?? null,
    })),
    pairCount,
  };
};

const makeTimeSourceCounts = (items: readonly MediaItem[]): Record<TimeSource, number> => {
  const counts: Record<TimeSource, number> = {
    "exif-naive": 0,
    "exif-with-offset": 0,
    filesystem: 0,
    "mp4-utc-converted": 0,
    "quicktime-local": 0,
    "user-override": 0,
  };
  for (const item of items) {
    counts[item.timeSource] += 1;
  }
  return counts;
};

const ensureUniqueMediaIds = (items: readonly MediaItem[]): MediaItem[] => {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  }
  return items.map((item) =>
    (counts.get(item.id) ?? 0) < 2
      ? item
      : {
          ...item,
          id: `${item.id}_${createHash("sha1")
            .update(item.relativePath)
            .digest("hex")
            .slice(0, 8)}`,
        },
  );
};

export const scanMediaFolder = async (
  sourceRoot: string,
  dependencies: ScanDependencies,
): Promise<ScanResult> => {
  if (!path.isAbsolute(sourceRoot)) {
    throw new Error("Media sourceRoot must be an absolute path");
  }

  const sourceStat = await stat(sourceRoot);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Media sourceRoot is not a directory: ${sourceRoot}`);
  }

  if (
    dependencies.projectUtcOffsetMin !== undefined &&
    (!Number.isInteger(dependencies.projectUtcOffsetMin) ||
      dependencies.projectUtcOffsetMin < -14 * 60 ||
      dependencies.projectUtcOffsetMin > 14 * 60)
  ) {
    throw new RangeError("projectUtcOffsetMin must be an integer between -840 and 840");
  }

  const filter = dependencies.mediaFilter ?? "all";
  const discovered = await discoverMedia(sourceRoot, filter);
  if (discovered.length === 0) {
    if (filter === "photo") {
      throw new Error(
        "선택한 이미지 폴더에서 지원되는 사진을 찾지 못했습니다. JPG, JPEG, PNG, HEIC, HEIF 파일이 있는 폴더를 선택하세요.",
      );
    }
    if (filter === "video") {
      throw new Error(
        "선택한 동영상 폴더에서 지원되는 영상을 찾지 못했습니다. MP4, MOV, M4V, MKV, AVI 파일이 있는 폴더를 선택하세요.",
      );
    }
    throw new Error(
      "선택한 폴더에서 지원되는 사진이나 영상을 찾지 못했습니다. JPG, JPEG, PNG, HEIC, HEIF, MP4, MOV 또는 M4V 파일이 있는 폴더를 선택하세요.",
    );
  }
  const concurrency = dependencies.concurrency ?? cpus().length;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError("concurrency must be a positive integer");
  }

  const limit = pLimit(concurrency);
  const metadataReader = dependencies.photoMetadataReader ?? new ExifrPhotoMetadataReader();
  let completed = 0;
  const rawItems = await Promise.all(
    discovered.map((file) =>
      limit(async () => {
        let raw: RawMedia;
        try {
          raw = await readRawMedia(file, metadataReader, dependencies.probe, dependencies.onLog);
        } catch (error) {
          const fallbackStat = await stat(file.absolutePath);
          raw = {
            ...file,
            contentHash: createHash("sha1")
              .update(`${fallbackStat.size}|${file.relativePath}`)
              .digest("hex")
              .slice(0, 12),
            fileSize: fallbackStat.size,
            issues: [error instanceof Error ? error.message : String(error)],
            modifiedAt: fallbackStat.mtime,
            photo:
              file.mediaType === "photo"
                ? {height: 1, metadata: null, orientationTag: null, width: 1}
                : null,
            probe: null,
          };
        }

        completed += 1;
        dependencies.onProgress?.({
          completed,
          currentPath: file.relativePath,
          progress: discovered.length === 0 ? 1 : completed / discovered.length,
          total: discovered.length,
        });
        return raw;
      }),
    ),
  );

  const fallbackOffsetMin = -new Date().getTimezoneOffset();
  const projectUtcOffsetMin =
    dependencies.projectUtcOffsetMin ??
    inferProjectUtcOffset(collectKnownOffsets(rawItems), fallbackOffsetMin);
  const materialized = ensureUniqueMediaIds(
    rawItems.map((raw) =>
      raw.mediaType === "photo" ? buildPhotoItem(raw) : buildVideoItem(raw, projectUtcOffsetMin),
    ),
  );
  materialized.sort(
    (left, right) =>
      left.capturedAtLocal.localeCompare(right.capturedAtLocal) ||
      left.relativePath.localeCompare(right.relativePath),
  );

  const paired = pairLivePhotos(materialized);
  const index = mediaIndexSchema.parse({
    createdAt: new Date().toISOString(),
    items: paired.items,
    schemaVersion: 2,
    sourceRoot,
  });
  const manifestKey = dependencies.manifestKey ?? DEFAULT_MEDIA_MANIFEST_KEY;

  await persistMediaIndex(dependencies.database, dependencies.storage, index, manifestKey);

  const timeSources = makeTimeSourceCounts(index.items);
  return {
    index,
    manifestKey,
    statistics: {
      errors: index.items.filter((item) => item.status === "error").length,
      estimatedUtcOffsetMin: projectUtcOffsetMin,
      heic: index.items.filter((item) => item.ext === "heic" || item.ext === "heif").length,
      heicDecoder: "heic-convert",
      livePhotoPairs: paired.pairCount,
      mp4UtcConvertedCount: timeSources["mp4-utc-converted"],
      photos: index.items.filter((item) => item.mediaType === "photo").length,
      timeSources,
      total: index.items.length,
      videos: index.items.filter((item) => item.mediaType === "video").length,
    },
  };
};
