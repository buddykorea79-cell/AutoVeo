import {randomUUID} from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import {mediaIndexSchema, type MediaIndex} from "@travel-movie/schema";

import type {OutputAspect, OutputResolution} from "./output-format.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";

export type OutputStyle = "cinematic-travel" | "bright-vlog" | "family";

export interface ProjectOutputSettings {
  readonly aspect: OutputAspect;
  readonly fps: 24 | 30 | 60;
  readonly resolution: OutputResolution;
  readonly style: OutputStyle;
}

export interface WebProject extends ProjectOutputSettings {
  readonly createdAt: string;
  readonly folderPath: string;
  readonly id: string;
  readonly scanStatistics: Record<string, unknown> | null;
  readonly title: string;
  readonly updatedAt: string;
  readonly utcOffsetMin: number;
}

interface ProjectRow {
  readonly created_at: string;
  readonly folder_path: string;
  readonly id: string;
  readonly output_aspect: string;
  readonly output_fps: number;
  readonly output_resolution: string;
  readonly output_style: string;
  readonly scan_statistics_json: string | null;
  readonly title: string;
  readonly updated_at: string;
  readonly utc_offset_min: number;
}

const asAspect = (value: string): OutputAspect =>
  value === "9:16" || value === "1:1" ? value : "16:9";

const asResolution = (value: string): OutputResolution =>
  value === "720p" || value === "4k" ? value : "1080p";

const asFps = (value: number): 24 | 30 | 60 => (value === 24 || value === 60 ? value : 30);

const asStyle = (value: string): OutputStyle =>
  value === "bright-vlog" || value === "family" ? value : "cinematic-travel";

const fromRow = (row: ProjectRow): WebProject => ({
  aspect: asAspect(row.output_aspect),
  createdAt: row.created_at,
  folderPath: row.folder_path,
  fps: asFps(row.output_fps),
  id: row.id,
  resolution: asResolution(row.output_resolution),
  scanStatistics:
    row.scan_statistics_json === null
      ? null
      : (JSON.parse(row.scan_statistics_json) as Record<string, unknown>),
  style: asStyle(row.output_style),
  title: row.title,
  updatedAt: row.updated_at,
  utcOffsetMin: row.utc_offset_min,
});

const slugify = (title: string): string => {
  const slug = title
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 24);
  return slug.length === 0 ? "movie" : slug;
};

export const createWebProject = (
  database: BetterSqlite3.Database,
  input: {
    readonly folderPath: string;
    readonly title: string;
    readonly utcOffsetMin?: number;
  },
): WebProject => {
  const now = new Date().toISOString();
  const id = `p_${slugify(input.title)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const utcOffsetMin = input.utcOffsetMin ?? -new Date().getTimezoneOffset();
  database
    .prepare(
      `INSERT INTO projects (
        id, title, folder_path, utc_offset_min, video_shift_min, time_confirmed,
        scan_statistics_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 1, NULL, ?, ?)`,
    )
    .run(id, input.title, input.folderPath, utcOffsetMin, now, now);
  return getWebProject(database, id)!;
};

export const getWebProject = (
  database: BetterSqlite3.Database,
  projectId: string,
): WebProject | null => {
  const row = database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
    ProjectRow | undefined;
  return row === undefined ? null : fromRow(row);
};

export const listWebProjects = (
  database: BetterSqlite3.Database,
  limit = 20,
): readonly WebProject[] =>
  (
    database
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as ProjectRow[]
  ).map(fromRow);

export const updateProjectScanStatistics = (
  database: BetterSqlite3.Database,
  projectId: string,
  statistics: Record<string, unknown>,
): void => {
  database
    .prepare("UPDATE projects SET scan_statistics_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(statistics), new Date().toISOString(), projectId);
};

export const updateProjectOutput = (
  database: BetterSqlite3.Database,
  projectId: string,
  output: ProjectOutputSettings,
): WebProject => {
  database
    .prepare(
      `UPDATE projects
       SET output_aspect = ?, output_resolution = ?, output_fps = ?, output_style = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      output.aspect,
      output.resolution,
      output.fps,
      output.style,
      new Date().toISOString(),
      projectId,
    );
  const project = getWebProject(database, projectId);
  if (project === null) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  return project;
};

/** 렌더 완료 표시는 파일 존재 여부로 판단하므로 별도 확인 플래그를 두지 않는다. */
export const updateTimelineConfirmation = (
  database: BetterSqlite3.Database,
  projectId: string,
  confirmed: boolean,
): void => {
  database
    .prepare("UPDATE projects SET timeline_confirmed = ?, updated_at = ? WHERE id = ?")
    .run(confirmed ? 1 : 0, new Date().toISOString(), projectId);
};

export const updateMusicConfirmation = (
  database: BetterSqlite3.Database,
  projectId: string,
  confirmed: boolean,
): void => {
  database
    .prepare("UPDATE projects SET music_confirmed = ?, updated_at = ? WHERE id = ?")
    .run(confirmed ? 1 : 0, new Date().toISOString(), projectId);
};

export const projectManifestKey = (projectId: string): string =>
  `manifests/${projectId}/media-index.json`;

export const loadProjectMediaIndex = async (
  storage: StorageAdapter,
  projectId: string,
): Promise<MediaIndex | null> => {
  const key = projectManifestKey(projectId);
  if (!(await storage.exists(key))) {
    return null;
  }
  return mediaIndexSchema.parse(JSON.parse((await storage.read(key)).toString("utf8")));
};
