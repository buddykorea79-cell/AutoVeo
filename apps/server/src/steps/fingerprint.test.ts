import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import sharp from "sharp";
import {afterEach, describe, expect, it} from "vitest";

import {dhashDistance} from "@travel-movie/core";
import {mediaIndexSchema, type MediaItem, type UserDecision} from "@travel-movie/schema";

import {runMigrations} from "../db/migrations.js";
import {LocalFsAdapter} from "../storage/local-fs-adapter.js";
import {calculateImageFingerprint, fingerprintMedia} from "./fingerprint.js";

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
});

const stripeImage = async (reverse = false): Promise<Buffer> => {
  const width = 900;
  const height = 640;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const stripe = Math.min(8, Math.floor((x / width) * 9));
      const base = reverse ? 235 - stripe * 27 : 19 + stripe * 27;
      const value = Math.max(0, Math.min(255, base + ((x + y) % 2 === 0 ? 5 : -5)));
      const offset = (y * width + x) * 3;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
    }
  }
  return sharp(pixels, {raw: {channels: 3, height, width}})
    .png()
    .toBuffer();
};

const checkerImage = async (): Promise<Buffer> => {
  const width = 512;
  const height = 512;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 0 : 255;
      const offset = (y * width + x) * 3;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
    }
  }
  return sharp(pixels, {raw: {channels: 3, height, width}})
    .png()
    .toBuffer();
};

const photoItem = (
  id: string,
  capturedAtLocal: string,
  analysisKey: string,
  userDecision: UserDecision = "auto",
): MediaItem => ({
  absolutePath: path.resolve("unused", `${id}.jpg`),
  analysisKey,
  blurScore: null,
  capturedAtLocal,
  clusterId: null,
  contentHash: id.padEnd(12, "0").slice(0, 12),
  dhash: null,
  exposureScore: null,
  ext: "jpg",
  filename: `${id}.jpg`,
  fileSize: 1,
  gps: null,
  height: 640,
  id,
  isClusterBest: true,
  issues: [],
  livePhoto: null,
  mediaType: "photo",
  orientation: "landscape",
  place: null,
  proxyKey: null,
  relativePath: `${id}.jpg`,
  renderAssetKey: null,
  rotationApplied: true,
  status: "ok",
  thumbKey: `thumbs/${id}.webp`,
  timeSource: "exif-naive",
  userDecision,
  utcOffsetMin: null,
  video: null,
  width: 900,
});

describe("calculateImageFingerprint", () => {
  it("keeps dHash stable under weak brightness and separates a reversed image", async () => {
    const original = await stripeImage();
    const brighter = await sharp(original).modulate({brightness: 1.05}).png().toBuffer();
    const different = await stripeImage(true);
    const [originalMetrics, brighterMetrics, differentMetrics] = await Promise.all([
      calculateImageFingerprint(original, true),
      calculateImageFingerprint(brighter, true),
      calculateImageFingerprint(different, true),
    ]);

    expect(dhashDistance(originalMetrics.dhash!, originalMetrics.dhash!)).toBe(0);
    expect(dhashDistance(originalMetrics.dhash!, brighterMetrics.dhash!)).toBeLessThanOrEqual(4);
    expect(dhashDistance(originalMetrics.dhash!, differentMetrics.dhash!)).toBeGreaterThanOrEqual(
      20,
    );
  });

  it("reports lower Laplacian variance after artificial blur", async () => {
    const original = await checkerImage();
    const blurred = await sharp(original).blur(8).png().toBuffer();
    const [originalMetrics, blurredMetrics] = await Promise.all([
      calculateImageFingerprint(original, true),
      calculateImageFingerprint(blurred, true),
    ]);
    expect(blurredMetrics.blurVariance).toBeLessThan(originalMetrics.blurVariance);
  });
});

describe("fingerprintMedia", () => {
  it("normalizes quality, clusters adjacent photos, honors include, caches, and persists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-fingerprint-"));
    temporaryRoots.push(root);
    const storage = new LocalFsAdapter(root);
    const database = new Database(":memory:");
    databases.push(database);
    runMigrations(database);

    const base = await stripeImage();
    const brighter = await sharp(base).modulate({brightness: 1.05}).png().toBuffer();
    const reverse = await stripeImage(true);
    const solid = await sharp({
      create: {background: "#808080", channels: 3, height: 640, width: 900},
    })
      .png()
      .toBuffer();
    const fixtures = new Map<string, Buffer>([
      ["analysis/m_a.jpg", base],
      ["analysis/m_b.jpg", brighter],
      ["analysis/m_c.jpg", base],
      ["analysis/m_d.jpg", reverse],
      ["analysis/m_blur.jpg", solid],
    ]);
    for (const [key, value] of fixtures) {
      await storage.write(key, value);
    }

    const input = mediaIndexSchema.parse({
      createdAt: new Date().toISOString(),
      items: [
        photoItem("m_a", "2026-05-12T10:00:00", "analysis/m_a.jpg"),
        photoItem("m_b", "2026-05-12T10:00:20", "analysis/m_b.jpg", "include"),
        photoItem("m_c", "2026-05-12T10:01:20", "analysis/m_c.jpg"),
        photoItem("m_d", "2026-05-12T10:01:30", "analysis/m_d.jpg"),
        photoItem("m_blur", "2026-05-12T10:02:30", "analysis/m_blur.jpg"),
      ],
      schemaVersion: 2,
      sourceRoot: path.join(root, "input"),
    });
    const progress: number[] = [];
    const result = await fingerprintMedia(
      input,
      {},
      {
        concurrency: 2,
        database,
        onProgress: (event) => progress.push(event.progress),
        storage,
      },
    );
    const byId = new Map(result.index.items.map((item) => [item.id, item]));

    expect(byId.get("m_a")?.clusterId).toBe(byId.get("m_b")?.clusterId);
    expect(byId.get("m_b")).toMatchObject({isClusterBest: true, userDecision: "include"});
    expect(byId.get("m_a")?.isClusterBest).toBe(false);
    expect(byId.get("m_c")?.clusterId).not.toBe(byId.get("m_b")?.clusterId);
    expect(byId.get("m_c")?.dhash).toBe(byId.get("m_a")?.dhash);
    expect(byId.get("m_d")?.clusterId).not.toBe(byId.get("m_c")?.clusterId);
    expect(byId.get("m_blur")?.issues).toContain("blurry");
    expect(byId.get("m_blur")?.status).toBe("warning");
    expect(result.statistics).toEqual({
      blurry: 1,
      cacheHits: 0,
      clusters: 4,
      processed: 5,
      selectionCandidates: 3,
      suppressedPhotos: 1,
    });
    expect(progress).toHaveLength(5);
    expect(progress.at(-1)).toBe(1);

    const cached = await fingerprintMedia(result.index, {}, {database, storage});
    expect(cached.statistics).toMatchObject({cacheHits: 5, processed: 0});
    expect(cached.index.items.map((item) => item.clusterId)).toEqual(
      result.index.items.map((item) => item.clusterId),
    );
    const persisted = mediaIndexSchema.parse(
      JSON.parse((await storage.read("manifests/media-index.json")).toString("utf8")),
    );
    expect(persisted).toEqual(cached.index);
    expect(
      (database.prepare("SELECT COUNT(*) AS count FROM media").get() as {count: number}).count,
    ).toBe(5);
  });
});
