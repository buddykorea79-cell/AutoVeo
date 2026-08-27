import {createHash} from "node:crypto";
import {readFile, stat} from "node:fs/promises";
import path from "node:path";

import {
  musicCatalogSchema,
  musicLibrarySchema,
  type MusicCatalog,
  type MusicLibrary,
} from "@travel-movie/schema";

import type {MediaProbe} from "./ffprobe.js";

export interface MusicLibraryDependencies {
  readonly catalogPath: string;
  readonly musicRoot: string;
  readonly probe: MediaProbe;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const readMusicCatalog = async (catalogPath: string): Promise<MusicCatalog> =>
  musicCatalogSchema.parse(JSON.parse(await readFile(catalogPath, "utf8")));

export const resolveMusicTrackPath = (musicRoot: string, relativePath: string): string => {
  const root = path.resolve(musicRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Music path escapes the configured library: ${relativePath}`);
  }
  if (path.extname(resolved).toLowerCase() !== ".mp3") {
    throw new Error(`Music track must be an MP3 file: ${relativePath}`);
  }
  return resolved;
};

const measuredDuration = (probe: Awaited<ReturnType<MediaProbe["probe"]>>): number | null => {
  const raw =
    probe.format?.duration ??
    probe.streams?.find((stream) => stream.codec_type === "audio")?.duration;
  const duration = Number(raw);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
};

export const musicLibraryInputHash = async (
  catalogPath: string,
  musicRoot: string,
): Promise<string> => {
  const catalogText = await readFile(catalogPath, "utf8");
  const catalog = musicCatalogSchema.parse(JSON.parse(catalogText));
  const files = await Promise.all(
    catalog.tracks.map(async (track) => {
      const absolutePath = resolveMusicTrackPath(musicRoot, track.path);
      try {
        const info = await stat(absolutePath);
        return {mtimeMs: info.mtimeMs, path: track.path, size: info.size};
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return {missing: true, path: track.path};
        }
        throw error;
      }
    }),
  );
  return createHash("sha1")
    .update(JSON.stringify({catalog: catalogText, files}))
    .digest("hex");
};

export const scanMusicLibrary = async (
  dependencies: MusicLibraryDependencies,
  onProgress?: (completed: number, total: number) => void,
): Promise<MusicLibrary> => {
  const catalog = await readMusicCatalog(dependencies.catalogPath);
  const tracks: MusicLibrary["tracks"] = [];
  const warnings: MusicLibrary["warnings"] = [];

  for (const [index, track] of catalog.tracks.entries()) {
    const absolutePath = resolveMusicTrackPath(dependencies.musicRoot, track.path);
    try {
      await stat(absolutePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        warnings.push({
          code: "missing-file",
          message: `파일을 찾을 수 없습니다: ${track.path}`,
          trackId: track.id,
        });
        onProgress?.(index + 1, catalog.tracks.length);
        continue;
      }
      throw error;
    }

    try {
      const durationSec = measuredDuration(await dependencies.probe.probe(absolutePath));
      if (durationSec === null) {
        throw new Error("오디오 길이를 읽을 수 없습니다.");
      }
      if (track.durationSec !== undefined && Math.abs(track.durationSec - durationSec) > 0.25) {
        warnings.push({
          code: "duration-mismatch",
          message: `메타데이터 ${track.durationSec.toFixed(2)}초 대신 실측 ${durationSec.toFixed(2)}초를 사용합니다.`,
          trackId: track.id,
        });
      }
      tracks.push({...track, durationSec});
    } catch (error) {
      warnings.push({
        code: "probe-failed",
        message: `MP3 정보를 읽지 못했습니다: ${errorMessage(error)}`,
        trackId: track.id,
      });
    }
    onProgress?.(index + 1, catalog.tracks.length);
  }

  return musicLibrarySchema.parse({
    scannedAt: new Date().toISOString(),
    schemaVersion: 2,
    tracks,
    warnings,
  });
};
