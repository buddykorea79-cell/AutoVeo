import {createHash} from "node:crypto";
import {copyFile, mkdir, mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import Database from "better-sqlite3";
import {ffmpegPath, ffprobePath} from "ffmpeg-ffprobe-static";
import sharp from "sharp";
import {afterEach, describe, expect, it} from "vitest";

import {mediaIndexSchema} from "@travel-movie/schema";

import {runMigrations} from "../db/migrations.js";
import {FfmpegService} from "../services/ffmpeg.js";
import {FfprobeService} from "../services/ffprobe.js";
import {LocalFsAdapter} from "../storage/local-fs-adapter.js";
import {makePrepareCacheKey, prepareMedia} from "./prepare.js";
import {scanMediaFolder} from "./scan.js";

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
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, {force: true, maxRetries: 5, recursive: true, retryDelay: 100})),
  );
}, 30_000);

const requireBinary = (value: string | null, name: string): string => {
  if (value === null) {
    throw new Error(`${name} binary was not installed`);
  }
  return value;
};

const fileHash = async (filePath: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");

describe("makePrepareCacheKey", () => {
  it("is stable across parameter key order and changes by stage", () => {
    const left = makePrepareCacheKey("thumb", "abc", {maxEdge: 256, quality: 72});
    const right = makePrepareCacheKey("thumb", "abc", {quality: 72, maxEdge: 256});
    expect(left).toBe(right);
    expect(makePrepareCacheKey("analysis", "abc", {quality: 72, maxEdge: 256})).not.toBe(left);
  });
});

describe("prepareMedia", () => {
  it("creates, verifies, caches, and partially renders real media without changing originals", async () => {
    const ffmpeg = new FfmpegService(requireBinary(ffmpegPath, "ffmpeg"));
    const probe = new FfprobeService(requireBinary(ffprobePath, "ffprobe"));
    const root = await mkdtemp(path.join(tmpdir(), "travel-prepare-test-"));
    temporaryRoots.push(root);
    const mediaRoot = path.join(root, "input");
    const storageRoot = path.join(root, "work");
    await mkdir(mediaRoot, {recursive: true});

    const photoPath = path.join(mediaRoot, "oriented.jpg");
    await sharp({
      create: {background: "#dd7744", channels: 3, height: 1800, width: 2400},
    })
      .jpeg({quality: 92})
      .withMetadata({orientation: 6})
      .toFile(photoPath);
    const heicPath = path.join(mediaRoot, "sample.heic");
    await copyFile(path.join(fixtureRoot, "official-sample.heic"), heicPath);

    const rotationSource = path.join(root, "rotation-source.mp4");
    await ffmpeg.run([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=64x48:r=10:d=1.2",
      "-an",
      "-c:v",
      "mpeg4",
      "-q:v",
      "2",
      rotationSource,
    ]);
    const videoPath = path.join(mediaRoot, "rotated.mp4");
    await ffmpeg.run([
      "-y",
      "-display_rotation:v:0",
      "90",
      "-i",
      rotationSource,
      "-c",
      "copy",
      videoPath,
    ]);

    const originalHashes = new Map(
      await Promise.all(
        [photoPath, heicPath, videoPath].map(
          async (filePath) => [filePath, await fileHash(filePath)] as const,
        ),
      ),
    );
    const database = new Database(":memory:");
    databases.push(database);
    runMigrations(database);
    const storage = new LocalFsAdapter(storageRoot);
    const scanned = await scanMediaFolder(mediaRoot, {
      concurrency: 2,
      database,
      probe,
      projectUtcOffsetMin: 540,
      storage,
    });
    const rotatedSource = scanned.index.items.find((item) => item.filename === "rotated.mp4");
    expect(rotatedSource).toMatchObject({height: 64, width: 48});

    const progress: number[] = [];
    const prepared = await prepareMedia(
      scanned.index,
      {stages: ["thumb", "analysis"]},
      {
        concurrency: 2,
        database,
        onProgress: (event) => progress.push(event.progress),
        probe,
        storage,
        transcoder: ffmpeg,
      },
    );
    expect(prepared.statistics).toEqual({
      cacheHits: 0,
      completedOperations: 6,
      largeFilesSequential: 0,
      processed: 6,
      selectedMedia: 3,
      totalOperations: 6,
    });
    expect(progress).toHaveLength(6);
    expect(progress.at(-1)).toBe(1);

    const byName = new Map(prepared.index.items.map((item) => [item.filename, item]));
    const photo = byName.get("oriented.jpg");
    const heic = byName.get("sample.heic");
    const video = byName.get("rotated.mp4");
    expect(photo).toMatchObject({rotationApplied: true});
    expect(heic).toMatchObject({rotationApplied: true});
    expect(video).toMatchObject({height: 64, rotationApplied: true, width: 48});

    for (const item of prepared.index.items) {
      expect(item.thumbKey).not.toBeNull();
      expect(item.analysisKey).not.toBeNull();
      await expect(storage.exists(item.thumbKey!)).resolves.toBe(true);
      await expect(storage.exists(item.analysisKey!)).resolves.toBe(true);
    }
    expect(photo?.proxyKey).toBeNull();
    expect(heic?.proxyKey).toBeNull();
    expect(video?.proxyKey).not.toBeNull();
    await expect(storage.exists(video!.proxyKey!)).resolves.toBe(true);

    const photoThumb = await sharp(
      await readFile(await storage.localPath(photo!.thumbKey!)),
    ).metadata();
    expect(photoThumb).toMatchObject({format: "webp", height: 256, width: 192});
    const photoAnalysis = await sharp(
      await readFile(await storage.localPath(photo!.analysisKey!)),
    ).metadata();
    expect(photoAnalysis).toMatchObject({format: "jpeg", height: 1024, width: 768});
    const videoThumb = await sharp(
      await readFile(await storage.localPath(video!.thumbKey!)),
    ).metadata();
    expect(videoThumb).toMatchObject({format: "webp", height: 64, width: 48});
    const proxyMetadata = await probe.probe(await storage.localPath(video!.proxyKey!));
    const proxyStream = proxyMetadata.streams?.find((stream) => stream.codec_type === "video");
    expect(proxyStream).toMatchObject({codec_name: "h264", height: 64, width: 48});
    expect(
      (proxyStream?.side_data_list ?? []).some((entry) => Math.abs(entry.rotation ?? 0) > 0),
    ).toBe(false);

    const cached = await prepareMedia(
      prepared.index,
      {stages: ["thumb", "analysis"]},
      {concurrency: 2, database, probe, storage, transcoder: ffmpeg},
    );
    expect(cached.statistics).toMatchObject({cacheHits: 6, processed: 0});

    const rendered = await prepareMedia(
      cached.index,
      {
        mediaIds: [photo!.id],
        renderTargetLongEdgePx: 1280,
        stages: ["render"],
      },
      {database, probe, storage, transcoder: ffmpeg},
    );
    const renderedPhoto = rendered.index.items.find((item) => item.id === photo!.id);
    const renderMetadata = await sharp(
      await readFile(await storage.localPath(renderedPhoto!.renderAssetKey!)),
    ).metadata();
    expect(renderMetadata).toMatchObject({format: "jpeg", height: 1792, width: 1344});
    expect(
      rendered.index.items
        .filter((item) => item.id !== photo!.id)
        .every((item) => item.renderAssetKey === null),
    ).toBe(true);
    expect(
      (await stat(await storage.localPath(renderedPhoto!.renderAssetKey!))).size,
    ).toBeGreaterThan(0);

    const persisted = mediaIndexSchema.parse(
      JSON.parse((await storage.read("manifests/media-index.json")).toString("utf8")),
    );
    expect(persisted).toEqual(rendered.index);
    expect(
      (database.prepare("SELECT COUNT(*) AS count FROM media").get() as {count: number}).count,
    ).toBe(3);

    for (const [filePath, hash] of originalHashes) {
      await expect(fileHash(filePath)).resolves.toBe(hash);
    }
  }, 120_000);

  it("rejects render generation without explicit selected ids", async () => {
    const database = new Database(":memory:");
    databases.push(database);
    runMigrations(database);
    const root = await mkdtemp(path.join(tmpdir(), "travel-prepare-guard-"));
    temporaryRoots.push(root);
    const storage = new LocalFsAdapter(root);
    const emptyIndex = mediaIndexSchema.parse({
      createdAt: new Date().toISOString(),
      items: [],
      schemaVersion: 2,
      sourceRoot: root,
    });
    const unavailable = {
      async probe(): Promise<never> {
        throw new Error("not used");
      },
    };
    const transcoder = {
      async run(): Promise<never> {
        throw new Error("not used");
      },
    };

    await expect(
      prepareMedia(
        emptyIndex,
        {stages: ["render"]},
        {database, probe: unavailable, storage, transcoder},
      ),
    ).rejects.toThrow("requires explicit selected mediaIds");
  });
});
