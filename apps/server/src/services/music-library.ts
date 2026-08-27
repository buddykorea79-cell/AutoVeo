import {createHash} from "node:crypto";
import {mkdir, readdir, readFile, stat, writeFile} from "node:fs/promises";
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

const ALLOWED_MOODS = new Set([
  "calm",
  "night",
  "upbeat",
  "emotional",
  "acoustic",
  "ambient",
  "cinematic",
]);

const sanitizeId = (relativePath: string): string => {
  const base = path.basename(relativePath, path.extname(relativePath));
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);
  return sanitized.length > 0
    ? sanitized
    : `track-${createHash("sha1").update(relativePath).digest("hex").slice(0, 8)}`;
};

const inferMood = (relativePath: string): string[] => {
  const parts = relativePath.split(/[\\/]/u);
  const folder = parts.length > 1 ? (parts[0] ?? "").toLowerCase() : "";
  if (ALLOWED_MOODS.has(folder)) {
    return [folder];
  }
  if (folder === "manual" || folder === "") {
    return ["calm"];
  }
  return ["calm"];
};

export const discoverMp3Files = async (musicRoot: string): Promise<string[]> => {
  const root = path.resolve(musicRoot);
  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp3") {
        const rel = path.relative(root, full).split(path.sep).join(path.posix.sep);
        if (rel.length > 0 && !rel.includes("..")) {
          results.push(rel);
        }
      }
    }
  };
  await walk(root);
  results.sort((a, b) => a.localeCompare(b));
  return results;
};

export const buildCatalogEntry = (relativePath: string): MusicCatalog["tracks"][number] => ({
  attribution: "Unknown",
  bpm: null,
  energy: 0.5,
  id: sanitizeId(relativePath),
  license: "User supplied",
  mood: inferMood(relativePath) as MusicCatalog["tracks"][number]["mood"],
  path: relativePath,
  tags: [],
});

const ensureUniqueIds = (tracks: MusicCatalog["tracks"]): MusicCatalog["tracks"] => {
  const seen = new Set<string>();
  return tracks.map((track) => {
    let id = track.id;
    let suffix = 1;
    while (seen.has(id)) {
      suffix += 1;
      id = `${track.id}-${suffix}`;
    }
    seen.add(id);
    return id === track.id ? track : {...track, id};
  });
};

export const ensureMusicCatalog = async (
  catalogPath: string,
  musicRoot: string,
): Promise<MusicCatalog> => {
  let catalog: MusicCatalog | null = null;
  try {
    const text = await readFile(catalogPath, "utf8");
    catalog = musicCatalogSchema.parse(JSON.parse(text));
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )) {
      const isJsonError = error instanceof SyntaxError;
      if (!isJsonError) {
        // Try to parse error from Zod etc, rethrow
        if (catalog === null) {
          // file exists but invalid -> throw
          throw error;
        }
      }
    }
    catalog = null;
  }

  if (catalog !== null && catalog.tracks.length > 0) {
    return catalog;
  }

  const files = await discoverMp3Files(musicRoot);
  if (files.length === 0) {
    const empty: MusicCatalog = {schemaVersion: 2, tracks: []};
    if (catalog === null) {
      await mkdir(path.dirname(catalogPath), {recursive: true});
      await writeFile(catalogPath, JSON.stringify(empty, null, 2), "utf8");
    }
    return empty;
  }

  const existingPaths = new Set((catalog?.tracks ?? []).map((t) => t.path));
  const newEntries = files.filter((f) => !existingPaths.has(f)).map(buildCatalogEntry);
  const merged = ensureUniqueIds([...(catalog?.tracks ?? []), ...newEntries]);

  const next: MusicCatalog = {schemaVersion: 2, tracks: merged};
  await mkdir(path.dirname(catalogPath), {recursive: true});
  await writeFile(catalogPath, JSON.stringify(next, null, 2), "utf8");
  return next;
};

export const readMusicCatalog = async (catalogPath: string): Promise<MusicCatalog> =>
  musicCatalogSchema.parse(JSON.parse(await readFile(catalogPath, "utf8")));

export const writeMusicCatalog = async (
  catalogPath: string,
  catalog: MusicCatalog,
): Promise<void> => {
  const parsed = musicCatalogSchema.parse(catalog);
  await mkdir(path.dirname(catalogPath), {recursive: true});
  await writeFile(catalogPath, JSON.stringify(parsed, null, 2), "utf8");
};

export const refreshMusicCatalogFromFiles = async (
  catalogPath: string,
  musicRoot: string,
): Promise<MusicCatalog> => {
  const files = await discoverMp3Files(musicRoot);
  let existing: MusicCatalog | null;
  try {
    existing = musicCatalogSchema.parse(JSON.parse(await readFile(catalogPath, "utf8")));
  } catch {
    existing = null;
  }
  const byPath = new Map((existing?.tracks ?? []).map((t) => [t.path, t]));
  const tracks = ensureUniqueIds(files.map((rel) => byPath.get(rel) ?? buildCatalogEntry(rel)));
  const next: MusicCatalog = {schemaVersion: 2, tracks};
  await writeMusicCatalog(catalogPath, next);
  return next;
};

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
  await ensureMusicCatalog(catalogPath, musicRoot);
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
  const catalog = await ensureMusicCatalog(dependencies.catalogPath, dependencies.musicRoot);
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
