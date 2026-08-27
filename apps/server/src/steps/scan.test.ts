import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import Database from "better-sqlite3";
import {ffmpegPath, ffprobePath} from "ffmpeg-ffprobe-static";
import sharp from "sharp";
import {afterEach, describe, expect, it} from "vitest";

import {mediaIndexSchema} from "@travel-movie/schema";

import {runMigrations} from "../db/migrations.js";
import {FfprobeService} from "../services/ffprobe.js";
import {LocalFsAdapter} from "../storage/local-fs-adapter.js";
import {
  computePartialHash,
  hashMediaFolderSnapshot,
  inferProjectUtcOffset,
  normalizePhotoCaptureTime,
  normalizeVideoCaptureTime,
  scanMediaFolder,
} from "./scan.js";

interface PiexifApi {
  readonly ExifIFD: {readonly DateTimeOriginal: number};
  readonly GPSIFD: {
    readonly GPSAltitude: number;
    readonly GPSAltitudeRef: number;
    readonly GPSLatitude: number;
    readonly GPSLatitudeRef: number;
    readonly GPSLongitude: number;
    readonly GPSLongitudeRef: number;
  };
  readonly ImageIFD: {readonly Orientation: number};
  readonly TAGS: {
    readonly Exif: Record<number, {name: string; type: string}>;
  };
  dump(value: Record<string, unknown>): string;
  insert(exif: string, jpeg: string): string;
}

const require = createRequire(import.meta.url);
const piexif = require("piexifjs/piexif.js") as PiexifApi;
const OFFSET_TIME_ORIGINAL_TAG = 36_881;
piexif.TAGS.Exif[OFFSET_TIME_ORIGINAL_TAG] = {
  name: "OffsetTimeOriginal",
  type: "Ascii",
};

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tests/fixtures",
);
const temporaryRoots: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, {force: true, recursive: true})),
  );
});

const requireBinary = (value: string | null, name: string): string => {
  if (value === null) {
    throw new Error(`${name} binary was not installed`);
  }
  return value;
};

const runBinary = async (binary: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${path.basename(binary)} exited with ${String(code)}: ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });

interface ExifFixtureOptions {
  readonly dateTimeOriginal: string;
  readonly gps?: {readonly alt: number; readonly lat: number; readonly lon: number};
  readonly offsetTimeOriginal?: string;
  readonly orientation?: number;
}

const coordinateToRationals = (
  value: number,
): [[number, number], [number, number], [number, number]] => {
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutesDecimal = (absolute - degrees) * 60;
  const minutes = Math.floor(minutesDecimal);
  const seconds = Math.round((minutesDecimal - minutes) * 3_600_000);
  return [
    [degrees, 1],
    [minutes, 1],
    [seconds, 1_000],
  ];
};

const writeExifJpeg = async (filePath: string, options: ExifFixtureOptions): Promise<void> => {
  const jpeg = await sharp({
    create: {background: "#3366cc", channels: 3, height: 60, width: 80},
  })
    .jpeg()
    .toBuffer();
  const exif: Record<number, unknown> = {
    [piexif.ExifIFD.DateTimeOriginal]: options.dateTimeOriginal,
  };
  const gps: Record<number, unknown> = {};
  const zeroth: Record<number, unknown> = {};

  if (options.offsetTimeOriginal !== undefined) {
    exif[OFFSET_TIME_ORIGINAL_TAG] = options.offsetTimeOriginal;
  }
  if (options.orientation !== undefined) {
    zeroth[piexif.ImageIFD.Orientation] = options.orientation;
  }
  if (options.gps !== undefined) {
    gps[piexif.GPSIFD.GPSLatitudeRef] = options.gps.lat < 0 ? "S" : "N";
    gps[piexif.GPSIFD.GPSLatitude] = coordinateToRationals(options.gps.lat);
    gps[piexif.GPSIFD.GPSLongitudeRef] = options.gps.lon < 0 ? "W" : "E";
    gps[piexif.GPSIFD.GPSLongitude] = coordinateToRationals(options.gps.lon);
    gps[piexif.GPSIFD.GPSAltitudeRef] = options.gps.alt < 0 ? 1 : 0;
    gps[piexif.GPSIFD.GPSAltitude] = [Math.round(Math.abs(options.gps.alt) * 100), 100];
  }

  const exifBytes = piexif.dump({
    "0th": zeroth,
    "1st": {},
    Exif: exif,
    GPS: gps,
    thumbnail: null,
  });
  const encoded = piexif.insert(exifBytes, jpeg.toString("binary"));
  await writeFile(filePath, Buffer.from(encoded, "binary"));
};

const makeVideo = async (
  binary: string,
  filePath: string,
  metadata: readonly string[],
  durationSec = 1,
): Promise<void> => {
  await runBinary(binary, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=blue:s=64x48:r=10:d=${String(durationSec)}`,
    "-an",
    "-c:v",
    "mpeg4",
    "-q:v",
    "2",
    ...metadata,
    filePath,
  ]);
};

describe("capture time normalization", () => {
  const modifiedAt = new Date("2026-01-02T03:04:05Z");

  it("keeps EXIF wall time and records its explicit offset", () => {
    expect(
      normalizePhotoCaptureTime(
        {
          dateTimeOriginal: "2026:05:12 10:20:30",
          gps: null,
          offsetTimeOriginal: "+09:00",
          orientation: 1,
        },
        modifiedAt,
      ),
    ).toEqual({
      capturedAtLocal: "2026-05-12T10:20:30",
      timeSource: "exif-with-offset",
      utcOffsetMin: 540,
    });
  });

  it("converts MP4 UTC time with the project offset", () => {
    expect(
      normalizeVideoCaptureTime(
        {format: {tags: {creation_time: "2026-05-12T05:30:00Z"}}},
        modifiedAt,
        540,
      ),
    ).toEqual({
      capturedAtLocal: "2026-05-12T14:30:00",
      timeSource: "mp4-utc-converted",
      utcOffsetMin: 540,
    });
  });

  it("uses the modal known offset with a deterministic tie-break", () => {
    expect(inferProjectUtcOffset([540, 540, 60, 60, 60], 0)).toBe(60);
    expect(inferProjectUtcOffset([540, 60], 0)).toBe(60);
    expect(inferProjectUtcOffset([], 540)).toBe(540);
  });
});

describe("computePartialHash", () => {
  it("hashes size and the available head bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-hash-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, "sample.bin");
    const content = Buffer.from("travel-movie-hash-fixture");
    await writeFile(filePath, content);

    const expected = createHash("sha1")
      .update(String(content.length))
      .update(content)
      .digest("hex")
      .slice(0, 12);
    await expect(computePartialHash(filePath, content.length)).resolves.toBe(expected);
  });
});

describe("scanMediaFolder", () => {
  it("rejects a folder with no supported media instead of reporting a successful empty scan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-empty-scan-"));
    temporaryRoots.push(root);

    await expect(hashMediaFolderSnapshot(root)).rejects.toThrow(
      "선택한 폴더에서 지원되는 사진이나 영상을 찾지 못했습니다",
    );
  });

  it("follows a directory reparse point that stays inside the selected folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-linked-scan-"));
    temporaryRoots.push(root);
    const mediaRoot = path.join(root, "input");
    const originalsRoot = path.join(mediaRoot, "z-originals");
    await mkdir(originalsRoot, {recursive: true});
    const originalPath = path.join(originalsRoot, "original.jpg");
    await writeExifJpeg(originalPath, {dateTimeOriginal: "2026:05:12 09:00:00"});
    await symlink(originalsRoot, path.join(mediaRoot, "a-linked"), "junction");

    const database = new Database(":memory:");
    databases.push(database);
    runMigrations(database);
    const result = await scanMediaFolder(mediaRoot, {
      concurrency: 1,
      database,
      photoMetadataReader: {
        read: async () => ({
          dateTimeOriginal: "2026:05:12 09:00:00",
          gps: null,
          offsetTimeOriginal: null,
          orientation: 1,
        }),
      },
      probe: {probe: async () => ({})},
      projectUtcOffsetMin: 540,
      storage: new LocalFsAdapter(path.join(root, "work")),
    });

    expect(result.index.items.map((item) => item.relativePath)).toEqual([
      path.join("a-linked", "original.jpg"),
    ]);
    expect(result.statistics.photos).toBe(1);
  });

  it("assigns unique media IDs to separate files with identical content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-duplicate-scan-"));
    temporaryRoots.push(root);
    const mediaRoot = path.join(root, "input");
    await mkdir(mediaRoot, {recursive: true});
    const firstPath = path.join(mediaRoot, "same.jpg");
    await writeExifJpeg(firstPath, {dateTimeOriginal: "2026:05:12 09:00:00"});
    await copyFile(firstPath, path.join(mediaRoot, "same-copy.jpg"));
    const database = new Database(":memory:");
    databases.push(database);
    runMigrations(database);

    const result = await scanMediaFolder(mediaRoot, {
      concurrency: 1,
      database,
      photoMetadataReader: {
        read: async () => ({
          dateTimeOriginal: "2026:05:12 09:00:00",
          gps: null,
          offsetTimeOriginal: null,
          orientation: 1,
        }),
      },
      probe: {probe: async () => ({})},
      projectUtcOffsetMin: 540,
      storage: new LocalFsAdapter(path.join(root, "work")),
    });

    expect(new Set(result.index.items.map((item) => item.contentHash)).size).toBe(1);
    expect(new Set(result.index.items.map((item) => item.id)).size).toBe(2);
  });

  it("indexes real EXIF, HEIC, QuickTime, MP4 UTC, rotation, and Live Photo media", async () => {
    const ffmpeg = requireBinary(ffmpegPath, "ffmpeg");
    const ffprobe = requireBinary(ffprobePath, "ffprobe");
    const root = await mkdtemp(path.join(tmpdir(), "travel-scan-"));
    temporaryRoots.push(root);
    const mediaRoot = path.join(root, "input");
    const storageRoot = path.join(root, "work");
    await mkdir(mediaRoot, {recursive: true});

    await Promise.all([
      writeExifJpeg(path.join(mediaRoot, "offset.jpg"), {
        dateTimeOriginal: "2026:05:12 10:00:00",
        offsetTimeOriginal: "+09:00",
      }),
      writeExifJpeg(path.join(mediaRoot, "naive.jpg"), {
        dateTimeOriginal: "2026:05:12 09:00:00",
      }),
      writeExifJpeg(path.join(mediaRoot, "gps.jpg"), {
        dateTimeOriginal: "2026:05:12 11:00:00",
        gps: {alt: 27.5, lat: 37.5, lon: 127},
      }),
      writeExifJpeg(path.join(mediaRoot, "oriented.jpg"), {
        dateTimeOriginal: "2026:05:12 12:00:00",
        orientation: 6,
      }),
      writeExifJpeg(path.join(mediaRoot, "live.jpg"), {
        dateTimeOriginal: "2026:05:12 13:00:00",
        offsetTimeOriginal: "+09:00",
      }),
      copyFile(
        path.join(fixtureRoot, "official-sample.heic"),
        path.join(mediaRoot, "official-sample.heic"),
      ),
    ]);

    await makeVideo(
      ffmpeg,
      path.join(mediaRoot, "live.mov"),
      [
        "-movflags",
        "use_metadata_tags",
        "-metadata",
        "com.apple.quicktime.creationdate=2026-05-12T13:00:01+0900",
      ],
      2,
    );
    await makeVideo(ffmpeg, path.join(mediaRoot, "utc.mp4"), [
      "-metadata",
      "creation_time=2026-05-12T05:30:00Z",
    ]);
    const rotationSource = path.join(root, "rotation-source.mp4");
    await makeVideo(ffmpeg, rotationSource, ["-metadata", "creation_time=2026-05-12T06:00:00Z"]);
    await runBinary(ffmpeg, [
      "-y",
      "-display_rotation:v:0",
      "90",
      "-i",
      rotationSource,
      "-c",
      "copy",
      "-metadata:s:v:0",
      "rotate=90",
      path.join(mediaRoot, "rotated.mp4"),
    ]);

    const database = new Database(":memory:");
    databases.push(database);
    runMigrations(database);
    const storage = new LocalFsAdapter(storageRoot);
    const progress: number[] = [];
    const logs: string[] = [];
    const result = await scanMediaFolder(mediaRoot, {
      concurrency: 2,
      database,
      onLog: (message) => logs.push(message),
      onProgress: (event) => progress.push(event.progress),
      probe: new FfprobeService(ffprobe),
      projectUtcOffsetMin: 540,
      storage,
    });

    expect(
      result.index.items
        .filter((item) => item.status === "error")
        .map((item) => ({filename: item.filename, issues: item.issues})),
    ).toEqual([]);
    expect(result.statistics).toMatchObject({
      errors: 0,
      estimatedUtcOffsetMin: 540,
      heic: 1,
      heicDecoder: "heic-convert",
      livePhotoPairs: 1,
      photos: 6,
      total: 9,
      videos: 3,
    });
    expect(result.statistics.timeSources).toMatchObject({
      "exif-with-offset": 2,
      "mp4-utc-converted": 1,
      "quicktime-local": 1,
    });
    expect(progress).toHaveLength(9);
    expect(progress.at(-1)).toBe(1);
    expect(logs.some((message) => message.includes("HEIC decoder: heic-convert"))).toBe(true);

    const byName = new Map(result.index.items.map((item) => [item.filename, item]));
    expect(byName.get("offset.jpg")).toMatchObject({
      capturedAtLocal: "2026-05-12T10:00:00",
      timeSource: "exif-with-offset",
      utcOffsetMin: 540,
    });
    expect(byName.get("naive.jpg")).toMatchObject({
      capturedAtLocal: "2026-05-12T09:00:00",
      timeSource: "exif-naive",
      utcOffsetMin: null,
    });
    expect(byName.get("gps.jpg")?.gps).toMatchObject({alt: 27.5, lat: 37.5, lon: 127});
    expect(byName.get("oriented.jpg")).toMatchObject({
      height: 80,
      orientation: "portrait",
      width: 60,
    });
    expect(byName.get("official-sample.heic")).toMatchObject({height: 960, width: 1440});
    expect(byName.get("live.mov")).toMatchObject({
      capturedAtLocal: "2026-05-12T13:00:01",
      timeSource: "quicktime-local",
      utcOffsetMin: 540,
    });
    expect(byName.get("utc.mp4")).toMatchObject({
      capturedAtLocal: "2026-05-12T14:30:00",
      timeSource: "mp4-utc-converted",
    });
    expect(byName.get("rotated.mp4")).toMatchObject({height: 64, width: 48});
    expect(byName.get("live.jpg")?.livePhoto?.pairId).toBe(
      byName.get("live.mov")?.livePhoto?.pairId,
    );

    const captureTimes = result.index.items.map((item) => item.capturedAtLocal);
    expect(captureTimes).toEqual([...captureTimes].sort());
    expect(
      (database.prepare("SELECT COUNT(*) AS count FROM media").get() as {count: number}).count,
    ).toBe(9);

    const manifest = mediaIndexSchema.parse(
      JSON.parse((await storage.read("manifests/media-index.json")).toString("utf8")),
    );
    expect(manifest).toEqual(result.index);
    expect(await readFile(await storage.localPath(result.manifestKey))).toBeInstanceOf(Buffer);
  }, 60_000);
});
