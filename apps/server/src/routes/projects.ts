import {randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import path from "node:path";

import type BetterSqlite3 from "better-sqlite3";
import type {FastifyInstance, FastifyReply} from "fastify";
import {z} from "zod";

import {
  clipStyleSchema,
  GROUP_CLIP_TIMING,
  lookPresetSchema,
  musicLibrarySchema,
  musicSelectionSchema,
  renderPlanSchema,
  VIDEO_SEGMENT_LIMITS,
  verifyReportSchema,
  type PhotoGroup,
  type PipelineClip,
  type VideoClipManifest,
  type VideoClipSegment,
} from "@travel-movie/schema";

import type {JobRunner, PipelineStepRequest} from "../jobs/job-runner.js";
import type {MediaTranscoder} from "../services/ffmpeg.js";
import type {MediaProbe} from "../services/ffprobe.js";
import type {RemotionRenderService} from "../services/remotion.js";
import type {ComfyService} from "../services/comfy.js";
import type {OllamaService} from "../services/ollama.js";
import {getAdminSettings, rememberLastFolder} from "../services/admin-settings.js";
import {persistMediaIndex} from "../services/media-index.js";
import {resolveMusicTrackPath} from "../services/music-library.js";
import {buildGroup, buildPhotoGroups} from "../services/photo-groups.js";
import {
  createWebProject,
  getWebProject,
  loadProjectMediaIndex,
  projectManifestKey,
  updateProjectOutput,
} from "../services/web-projects.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";
import {
  createImportStep,
  importStepInputHash,
  type ImportStepDependencies,
  type ImportStepName,
} from "../steps/import-pipeline.js";
import {
  createGroupClipsStep,
  groupClipsInputHash,
  loadGroupManifest,
  resolveGroups,
  saveGroupManifest,
  type GroupClipsParams,
} from "../steps/group-clips.js";
import {
  analyzeClipsInputHash,
  createAnalyzeClipsStep,
  loadClipManifest,
  saveClipManifest,
} from "../steps/analyze-clips.js";
import {assembleInputHash, createAssembleStep} from "../steps/assemble.js";
import {
  createMusicStep,
  musicLibraryKey,
  musicSelectionKey,
  musicStepInputHash,
  musicStepParamsSchema,
} from "../steps/music.js";
import {createSubtitleStep, subtitleStepInputHash} from "../steps/subtitle.js";
import {
  createTimelineStep,
  renderPlanKey,
  timelineStepInputHash,
  timelineWarningsKey,
} from "../steps/timeline.js";
import {
  createFinalizeStep,
  finalizeStepInputHash,
  type FinalVideoService,
} from "../steps/finalize.js";
import {createRenderStep, intermediateVideoKey, renderStepInputHash} from "../steps/render.js";
import {
  createDetectVideoSegmentsStep,
  createExtractVideoClipsStep,
  detectVideoSegmentsInputHash,
  extractVideoClipsInputHash,
  loadVideoClipManifest,
  saveVideoClipManifest,
  segmentId as makeSegmentId,
  type VideoClipsParams,
} from "../steps/video-clips.js";

interface ProjectRouteDependencies {
  readonly database: BetterSqlite3.Database;
  readonly finalizer?: FinalVideoService;
  readonly getComfy?: () => ComfyService | undefined;
  readonly jobRunner: JobRunner;
  readonly musicCatalogPath?: string;
  readonly musicRoot?: string;
  readonly ollama?: OllamaService;
  readonly probe?: MediaProbe;
  readonly renderer?: Pick<RemotionRenderService, "render">;
  readonly storage: StorageAdapter;
  readonly transcoder?: MediaTranscoder;
}

interface StepStatusRow {
  readonly error: string | null;
  readonly message: string | null;
  readonly progress: number;
  readonly state: string;
  readonly step_name: string;
}

const isValidStorageParam = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value);

const outputSettingsSchema = z
  .object({
    aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
    fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(30),
    resolution: z.enum(["720p", "1080p", "4k"]).default("1080p"),
    style: z.enum(["cinematic-travel", "bright-vlog", "family"]).default("cinematic-travel"),
  })
  .strict();

const createProjectBodySchema = z
  .object({
    folderPath: z.string().trim().min(1),
    title: z.string().trim().min(1).max(120),
  })
  .strict();

const runStepBodySchema = z.object({force: z.boolean().optional().default(false)}).strict();
const groupClipsStepBodySchema = z
  .object({
    force: z.boolean().optional().default(false),
    /** 지정하면 이 그룹의 클립만 다시 만든다. */
    groupIds: z.array(z.string().min(1)).max(200).optional().default([]),
  })
  .strict();
const musicStepBodySchema = musicStepParamsSchema
  .extend({force: z.boolean().default(false)})
  .strict();
const mediaPatchBodySchema = z
  .object({
    projectId: z.string().min(1),
    userDecision: z.enum(["auto", "include", "exclude"]),
  })
  .strict();
const clipPatchBodySchema = z
  .object({
    caption: z.string().max(120).nullable().optional(),
    endSec: z.number().finite().nonnegative().optional(),
    look: lookPresetSchema.optional(),
    selected: z.boolean().optional(),
    startSec: z.number().finite().nonnegative().optional(),
    transitionIn: z.enum(["cut", "fade", "crossfade"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "변경할 항목이 필요합니다.");
const clipOrderBodySchema = z.object({order: z.array(z.string().min(1)).min(1)}).strict();
const clipLookAllBodySchema = z.object({look: lookPresetSchema}).strict();

const groupsPutBodySchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            mediaIds: z
              .array(z.string().min(1))
              .min(1)
              .max(GROUP_CLIP_TIMING.maxPhotosPerGroup + 1),
            style: clipStyleSchema.optional(),
            title: z.string().trim().min(1).max(80).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const groupPatchBodySchema = z.object({style: clipStyleSchema}).strict();

const segmentPatchBodySchema = z
  .object({
    endSec: z.number().finite().nonnegative().optional(),
    selected: z.boolean().optional(),
    startSec: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "변경할 항목이 필요합니다.");

const segmentCreateBodySchema = z
  .object({
    endSec: z.number().finite().nonnegative(),
    mediaId: z.string().min(1),
    startSec: z.number().finite().nonnegative(),
  })
  .strict();

const pipelineStepSchema = z.enum([
  "import",
  "group-clips",
  "detect-video-segments",
  "extract-video-clips",
  "analyze-clips",
  "timeline",
  "music",
  "render",
  "finalize",
]);

const getStepStatuses = (
  database: BetterSqlite3.Database,
  projectId: string,
): Record<string, StepStatusRow> => {
  const rows = database
    .prepare(
      `SELECT s.step_name, s.state, s.progress, s.message, s.error
       FROM steps s
       JOIN jobs j ON j.id = s.job_id
       WHERE j.project_id = ?
       ORDER BY s.rowid DESC`,
    )
    .all(projectId) as StepStatusRow[];
  const result: Record<string, StepStatusRow> = {};
  for (const row of rows) {
    result[row.step_name] ??= row;
  }
  return result;
};

const stepDone = (status: StepStatusRow | undefined): boolean =>
  status?.state === "succeeded" || status?.state === "cached";

const streamVideo = async (
  filePath: string,
  rangeHeader: string | undefined,
  downloadName: string | null,
  reply: FastifyReply,
) => {
  const info = await stat(filePath);
  reply.header("Accept-Ranges", "bytes").type("video/mp4");
  if (downloadName !== null) {
    const safeName = downloadName.replace(/[^a-z0-9._-]+/giu, "-");
    reply.header("Content-Disposition", `attachment; filename="${safeName || "movie.mp4"}"`);
  }
  if (rangeHeader === undefined) {
    return reply.header("Content-Length", String(info.size)).send(createReadStream(filePath));
  }
  const match = /^bytes=(\d+)-(\d*)$/u.exec(rangeHeader);
  if (match === null) {
    return reply
      .code(416)
      .header("Content-Range", `bytes */${String(info.size)}`)
      .send();
  }
  const start = Number(match[1]);
  const requestedEnd = match[2]?.length === 0 ? info.size - 1 : Number(match[2]);
  const end = Math.min(requestedEnd, info.size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
    return reply
      .code(416)
      .header("Content-Range", `bytes */${String(info.size)}`)
      .send();
  }
  return reply
    .code(206)
    .header("Content-Length", String(end - start + 1))
    .header("Content-Range", `bytes ${String(start)}-${String(end)}/${String(info.size)}`)
    .send(createReadStream(filePath, {end, start}));
};

const mediaResponse = async (storage: StorageAdapter, projectId: string) => {
  const index = await loadProjectMediaIndex(storage, projectId);
  if (index === null) {
    return {items: [], summary: {excluded: 0, photos: 0, total: 0, videos: 0}};
  }
  const ordered = index.items.toSorted((left, right) =>
    left.capturedAtLocal.localeCompare(right.capturedAtLocal),
  );
  return {
    items: ordered.map((item) => ({
      capturedAtLocal: item.capturedAtLocal,
      durationSec: item.video?.durationSec ?? null,
      filename: item.filename,
      id: item.id,
      issues: item.issues,
      isClusterBest: item.isClusterBest,
      mediaType: item.mediaType,
      orientation: item.orientation,
      thumbUrl: item.thumbKey === null ? null : storage.publicUrl(item.thumbKey),
      userDecision: item.userDecision,
    })),
    summary: {
      excluded: ordered.filter((item) => item.userDecision === "exclude").length,
      photos: ordered.filter((item) => item.mediaType === "photo").length,
      total: ordered.length,
      videos: ordered.filter((item) => item.mediaType === "video").length,
    },
  };
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

const validateSegmentRange = (startSec: number, endSec: number): string | null => {
  const duration = endSec - startSec;
  if (duration < VIDEO_SEGMENT_LIMITS.minSec) {
    return `구간은 ${String(VIDEO_SEGMENT_LIMITS.minSec)}초보다 길어야 합니다.`;
  }
  if (duration > VIDEO_SEGMENT_LIMITS.maxSec) {
    return `구간은 ${String(VIDEO_SEGMENT_LIMITS.maxSec)}초를 넘을 수 없습니다.`;
  }
  return null;
};

const replaceSegment = (
  manifest: VideoClipManifest,
  segment: VideoClipSegment,
): VideoClipManifest => ({
  ...manifest,
  videos: manifest.videos.map((video) => ({
    ...video,
    segments: video.segments.map((entry) => (entry.id === segment.id ? segment : entry)),
  })),
});

/**
 * 그룹 화면은 클립을 만들기 전에도 구성을 보여 줘야 한다.
 * 아직 저장된 구성이 없으면 자동 묶기 결과를 미리 계산해 돌려준다.
 */
const groupsResponse = async (storage: StorageAdapter, projectId: string) => {
  const manifest = await loadGroupManifest(storage, projectId);
  const index = await loadProjectMediaIndex(storage, projectId);
  const groups =
    index === null ? (manifest?.groups ?? []) : await resolveGroups(projectId, index, storage);
  const thumbById = new Map(
    (index?.items ?? []).map((item) => [
      item.id,
      item.thumbKey === null ? null : storage.publicUrl(item.thumbKey),
    ]),
  );
  const nameById = new Map((index?.items ?? []).map((item) => [item.id, item.filename]));
  const usedIds = new Set(groups.flatMap((group) => group.mediaIds));
  return {
    groups: groups.map((group) => ({
      ...group,
      photoNames: group.mediaIds.map((mediaId) => nameById.get(mediaId) ?? mediaId),
      photoThumbs: group.mediaIds.map((mediaId) => thumbById.get(mediaId) ?? null),
    })),
    mode: manifest?.mode ?? "auto",
    // 어느 그룹에도 들어가지 않은 사진. 사람이 직접 넣을 수 있다.
    ungrouped: (index?.items ?? [])
      .filter(
        (item) =>
          item.mediaType === "photo" && item.userDecision !== "exclude" && !usedIds.has(item.id),
      )
      .map((item) => ({
        capturedAtLocal: item.capturedAtLocal,
        filename: item.filename,
        id: item.id,
        thumbUrl: item.thumbKey === null ? null : storage.publicUrl(item.thumbKey),
      })),
  };
};

const videoSegmentsResponse = async (storage: StorageAdapter, projectId: string) => {
  const manifest = await loadVideoClipManifest(storage, projectId);
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  return {
    videos: (manifest?.videos ?? []).map((video) => ({
      ...video,
      previewUrl: `${base}/media/${encodeURIComponent(video.mediaId)}/stream`,
      segments: video.segments.map((segment) => ({
        ...segment,
        clipUrl: segment.clip === null ? null : storage.publicUrl(segment.clip.assetKey),
        thumbUrl: segment.thumbKey === null ? null : storage.publicUrl(segment.thumbKey),
      })),
    })),
  };
};

const clipsResponse = async (storage: StorageAdapter, projectId: string) => {
  const manifest = await loadClipManifest(storage, projectId);
  if (manifest === null) {
    return {clips: [], totalDurationSec: 0};
  }
  const clips = manifest.clips.toSorted((left, right) => left.order - right.order);
  return {
    clips: clips.map((clip) => ({
      ...clip,
      previewUrl: `/api/projects/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(clip.id)}/stream`,
      thumbUrl: clip.thumbKey === null ? null : storage.publicUrl(clip.thumbKey),
    })),
    totalDurationSec:
      Math.round(
        clips.filter((clip) => clip.selected).reduce((sum, clip) => sum + clip.durationSec, 0) * 10,
      ) / 10,
  };
};

export const registerProjectRoutes = (
  app: FastifyInstance,
  {
    database,
    finalizer,
    getComfy,
    jobRunner,
    musicCatalogPath,
    musicRoot,
    ollama,
    probe,
    renderer,
    storage,
    transcoder,
  }: ProjectRouteDependencies,
): void => {
  app.addHook("preHandler", async (request, reply) => {
    const params = request.params as Record<string, string | undefined> | undefined;
    if (params === undefined) {
      return;
    }
    for (const key of ["id", "clipId", "mediaId", "segmentId", "groupId"] as const) {
      const value = params[key];
      if (value !== undefined && !isValidStorageParam(value)) {
        void reply.code(400).send({error: "invalid_id", field: key});
        return;
      }
    }
  });

  const projectOrNull = (id: string) => getWebProject(database, id);

  const activeJobId = (projectId: string): string | null => {
    const row = database
      .prepare("SELECT id FROM jobs WHERE project_id = ? AND state IN ('queued','running') LIMIT 1")
      .get(projectId) as {id: string} | undefined;
    return row?.id ?? null;
  };

  app.post<{Body: unknown}>("/api/projects", async (request, reply) => {
    const parsed = createProjectBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({error: "invalid_project", issues: parsed.error.issues});
    }
    const folderPath = parsed.data.folderPath;
    if (!path.isAbsolute(folderPath)) {
      return reply
        .code(400)
        .send({error: "folder_path_must_be_absolute", message: "폴더의 전체 경로를 입력하세요."});
    }
    const normalized = path.normalize(folderPath);
    const root = path.parse(normalized).root;
    if (normalized.length <= root.length) {
      return reply.code(400).send({
        error: "folder_path_is_root",
        message: "드라이브 루트는 소스 폴더로 사용할 수 없습니다.",
      });
    }
    if (normalized.split(path.sep).includes("..")) {
      return reply
        .code(400)
        .send({error: "folder_path_invalid", message: "폴더 경로에 '..'을 포함할 수 없습니다."});
    }
    try {
      if (!(await stat(folderPath)).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      return reply.code(400).send({
        error: "folder_not_readable",
        message: "폴더를 찾을 수 없거나 읽을 수 없습니다. 경로를 다시 확인하세요.",
      });
    }
    const settings = getAdminSettings(database);
    const project = createWebProject(database, {
      folderPath,
      title: parsed.data.title,
      utcOffsetMin: settings.defaultUtcOffsetMin,
    });
    rememberLastFolder(database, folderPath);
    return reply.code(201).send({...project, steps: {}});
  });

  app.get<{Params: {id: string}}>("/api/projects/:id", async (request, reply) => {
    const project = projectOrNull(request.params.id);
    if (project === null) {
      return reply.code(404).send({error: "project_not_found"});
    }
    return {
      ...project,
      activeJobId: activeJobId(project.id),
      steps: getStepStatuses(database, project.id),
    };
  });

  app.patch<{Body: unknown; Params: {id: string}}>(
    "/api/projects/:id/output",
    async (request, reply) => {
      const project = projectOrNull(request.params.id);
      if (project === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const parsed = outputSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({error: "invalid_output", issues: parsed.error.issues});
      }
      const updated = updateProjectOutput(database, project.id, parsed.data);
      return {
        ...updated,
        activeJobId: activeJobId(project.id),
        steps: getStepStatuses(database, project.id),
      };
    },
  );

  app.get<{Params: {id: string}}>("/api/jobs/:id", async (request, reply) => {
    const job = jobRunner.getJob(request.params.id);
    if (job === null) {
      return reply.code(404).send({error: "job_not_found"});
    }
    return {...job, steps: jobRunner.getSteps(job.id)};
  });

  app.get<{Params: {id: string}}>("/api/projects/:id/events", async (request, reply) => {
    if (projectOrNull(request.params.id) === null) {
      return reply.code(404).send({error: "project_not_found"});
    }
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    });
    // 서버를 다시 시작한 뒤에는 메모리 스냅샷이 비어 있으므로 DB 상태로 채운다.
    const liveSnapshot = jobRunner.events.snapshot(request.params.id);
    const snapshot =
      liveSnapshot.length > 0
        ? liveSnapshot
        : Object.values(getStepStatuses(database, request.params.id)).map((row) => ({
            etaSec: null,
            message: row.message,
            progress: row.progress,
            state: row.state,
            step: row.step_name,
          }));
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    const unsubscribe = jobRunner.events.subscribe(request.params.id, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return reply;
  });

  app.post<{Params: {id: string}}>("/api/projects/:id/jobs/cancel", async (request, reply) => {
    if (projectOrNull(request.params.id) === null) {
      return reply.code(404).send({error: "project_not_found"});
    }
    return {cancelled: await jobRunner.cancelProjectJobs(request.params.id)};
  });

  app.post<{Body: unknown; Params: {id: string; step: string}}>(
    "/api/projects/:id/steps/:step/run",
    async (request, reply) => {
      const stepResult = pipelineStepSchema.safeParse(request.params.step);
      if (!stepResult.success) {
        return reply.code(400).send({error: "invalid_step_request"});
      }
      const project = projectOrNull(request.params.id);
      if (project === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const running = activeJobId(project.id);
      if (running !== null) {
        return reply.code(409).send({error: "job_already_running", jobId: running});
      }
      if (probe === undefined || transcoder === undefined) {
        return reply.code(503).send({error: "media_services_unavailable"});
      }

      const projectId = project.id;
      const output = {
        aspect: project.aspect,
        fps: project.fps,
        resolution: project.resolution,
        style: project.style,
      };
      let force = false;
      let steps: PipelineStepRequest[];

      try {
        if (stepResult.data === "import") {
          const body = runStepBodySchema.safeParse(request.body ?? {});
          if (!body.success) {
            return reply.code(400).send({error: "invalid_step_request"});
          }
          force = body.data.force;
          const dependencies: ImportStepDependencies = {database, probe, storage, transcoder};
          const names: ImportStepName[] = ["scan", "prepare", "fingerprint"];
          steps = names.map((name) => ({
            // 앞 단계가 끝나야 다음 단계의 입력이 정해지므로 실행 직전에 계산한다.
            inputHash: async () => importStepInputHash(projectId, name, dependencies),
            params: {force},
            step: createImportStep(projectId, name, dependencies, force),
          }));
        } else if (stepResult.data === "group-clips") {
          const body = groupClipsStepBodySchema.safeParse(request.body ?? {});
          if (!body.success) {
            return reply.code(400).send({error: "invalid_step_request"});
          }
          force = body.data.force;
          const groupIds = body.data.groupIds;
          const params: GroupClipsParams = {
            aspect: output.aspect,
            fps: output.fps,
            resolution: output.resolution,
          };
          const dependencies = {
            comfy: getComfy?.(),
            database,
            probe,
            renderer,
            storage,
            transcoder,
          };
          steps = [
            {
              inputHash: await groupClipsInputHash(projectId, dependencies, params),
              // groupIds 가 캐시 키에 들어가야 같은 그룹을 다시 만들라는 요청이 통한다.
              params: {...params, groupIds},
              step: createGroupClipsStep(projectId, params, dependencies, force, groupIds),
            },
          ];
        } else if (stepResult.data === "detect-video-segments") {
          const body = runStepBodySchema.safeParse(request.body ?? {});
          if (!body.success) {
            return reply.code(400).send({error: "invalid_step_request"});
          }
          force = body.data.force;
          steps = [
            {
              inputHash: await detectVideoSegmentsInputHash(projectId, storage),
              params: {force},
              step: createDetectVideoSegmentsStep(projectId, {storage, transcoder}),
            },
          ];
        } else if (stepResult.data === "extract-video-clips") {
          const body = runStepBodySchema.safeParse(request.body ?? {});
          if (!body.success) {
            return reply.code(400).send({error: "invalid_step_request"});
          }
          force = body.data.force;
          const params: VideoClipsParams = {
            aspect: output.aspect,
            fps: output.fps,
            resolution: output.resolution,
          };
          steps = [
            {
              inputHash: await extractVideoClipsInputHash(projectId, storage, params),
              params,
              step: createExtractVideoClipsStep(
                projectId,
                params,
                {database, probe, storage, transcoder},
                force,
              ),
            },
          ];
        } else if (stepResult.data === "analyze-clips") {
          const body = runStepBodySchema.safeParse(request.body ?? {});
          if (!body.success) {
            return reply.code(400).send({error: "invalid_step_request"});
          }
          force = body.data.force;
          const dependencies = {database, ollama, storage, transcoder};
          steps = [
            {
              inputHash: await analyzeClipsInputHash(projectId, dependencies),
              params: {force},
              step: createAnalyzeClipsStep(projectId, dependencies),
            },
          ];
        } else if (stepResult.data === "timeline") {
          const body = runStepBodySchema.safeParse(request.body ?? {});
          if (!body.success) {
            return reply.code(400).send({error: "invalid_step_request"});
          }
          force = body.data.force;
          const assembleParams = {
            aspect: output.aspect,
            fps: output.fps,
            resolution: output.resolution,
            style: output.style,
          };
          steps = [
            {
              inputHash: await assembleInputHash(projectId, {storage}, assembleParams),
              params: assembleParams,
              step: createAssembleStep(projectId, project.title, assembleParams, {storage}),
            },
            {
              inputHash: async () => subtitleStepInputHash(projectId, storage),
              params: {force},
              step: createSubtitleStep(projectId, storage),
            },
            {
              inputHash: async () => timelineStepInputHash(projectId, {storage}),
              params: {force},
              step: createTimelineStep(projectId, {database, probe, storage, transcoder}, force),
            },
          ];
        } else if (stepResult.data === "music") {
          const body = musicStepBodySchema.safeParse(request.body ?? {});
          if (!body.success) {
            return reply
              .code(400)
              .send({error: "invalid_music_request", issues: body.error.issues});
          }
          if (musicCatalogPath === undefined || musicRoot === undefined) {
            return reply.code(503).send({error: "music_services_unavailable"});
          }
          const {force: requestedForce, ...params} = body.data;
          force = requestedForce;
          const dependencies = {
            catalogPath: musicCatalogPath,
            database,
            musicRoot,
            probe,
            storage,
          };
          steps = [
            {
              inputHash: await musicStepInputHash(projectId, dependencies),
              params,
              step: createMusicStep(projectId, params, dependencies),
            },
          ];
        } else if (stepResult.data === "render") {
          const body = runStepBodySchema.safeParse(request.body ?? {});
          if (!body.success) {
            return reply.code(400).send({error: "invalid_step_request"});
          }
          if (renderer === undefined) {
            return reply.code(503).send({error: "render_service_unavailable"});
          }
          force = body.data.force;
          steps = [
            {
              inputHash: await renderStepInputHash(projectId, {storage}),
              params: {force},
              step: createRenderStep(projectId, {renderer, storage}),
            },
          ];
        } else {
          const body = runStepBodySchema.safeParse(request.body ?? {});
          if (!body.success) {
            return reply.code(400).send({error: "invalid_step_request"});
          }
          if (!stepDone(getStepStatuses(database, projectId).render)) {
            throw new Error("무음 영상을 먼저 만드세요.");
          }
          if (finalizer === undefined) {
            return reply.code(503).send({error: "finalize_service_unavailable"});
          }
          force = body.data.force;
          steps = [
            {
              inputHash: await finalizeStepInputHash(projectId, {storage}),
              params: {force},
              step: createFinalizeStep(projectId, project.title, {finalizer, storage}),
            },
          ];
        }
      } catch (error) {
        return reply.code(409).send({
          error: "step_prerequisite_missing",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      const jobId = `j_${randomUUID().replaceAll("-", "")}`;
      void jobRunner.runPipeline({force, jobId, projectId, steps}).catch(() => undefined);
      return reply.code(202).send({jobId, state: "queued", step: stepResult.data});
    },
  );

  app.get<{Params: {id: string}}>("/api/projects/:id/media", async (request, reply) => {
    if (projectOrNull(request.params.id) === null) {
      return reply.code(404).send({error: "project_not_found"});
    }
    return mediaResponse(storage, request.params.id);
  });

  app.patch<{Body: unknown; Params: {mediaId: string}}>(
    "/api/media/:mediaId",
    async (request, reply) => {
      const parsed = mediaPatchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({error: "invalid_media_patch", issues: parsed.error.issues});
      }
      const project = projectOrNull(parsed.data.projectId);
      if (project === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const index = await loadProjectMediaIndex(storage, project.id);
      if (index === null) {
        return reply.code(409).send({error: "media_index_missing"});
      }
      if (!index.items.some((item) => item.id === request.params.mediaId)) {
        return reply.code(404).send({error: "media_not_found"});
      }
      await persistMediaIndex(
        database,
        storage,
        {
          ...index,
          items: index.items.map((item) =>
            item.id === request.params.mediaId
              ? {...item, userDecision: parsed.data.userDecision}
              : item,
          ),
        },
        projectManifestKey(project.id),
      );
      return mediaResponse(storage, project.id);
    },
  );

  app.get<{Params: {id: string}}>("/api/projects/:id/groups", async (request, reply) => {
    if (projectOrNull(request.params.id) === null) {
      return reply.code(404).send({error: "project_not_found"});
    }
    return groupsResponse(storage, request.params.id);
  });

  /** 사람이 직접 고친 그룹 구성을 저장한다. 이후 자동 묶기가 덮어쓰지 않는다. */
  app.put<{Body: unknown; Params: {id: string}}>(
    "/api/projects/:id/groups",
    async (request, reply) => {
      if (projectOrNull(request.params.id) === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const parsed = groupsPutBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({error: "invalid_groups", issues: parsed.error.issues});
      }
      const index = await loadProjectMediaIndex(storage, request.params.id);
      if (index === null) {
        return reply.code(409).send({error: "media_index_missing"});
      }
      const itemById = new Map(index.items.map((item) => [item.id, item] as const));
      const seen = new Set<string>();
      for (const group of parsed.data.groups) {
        for (const mediaId of group.mediaIds) {
          const item = itemById.get(mediaId);
          if (item === undefined || item.mediaType !== "photo") {
            return reply.code(400).send({
              error: "group_photo_not_found",
              message: `사진을 찾을 수 없습니다: ${mediaId}`,
            });
          }
          if (seen.has(mediaId)) {
            return reply.code(400).send({
              error: "group_photo_duplicated",
              message: "한 사진은 그룹 하나에만 넣을 수 있습니다.",
            });
          }
          seen.add(mediaId);
        }
      }

      const previous = await loadGroupManifest(storage, request.params.id);
      const previousByKey = new Map(
        (previous?.groups ?? []).map(
          (group) => [[...group.mediaIds].sort().join("|"), group] as const,
        ),
      );
      const groups: PhotoGroup[] = parsed.data.groups.map((group, position) => {
        const built = buildGroup(
          request.params.id,
          group.mediaIds.map((mediaId) => itemById.get(mediaId)!),
          position,
          "user",
        );
        // 사진 구성이 그대로면 이미 만들어 둔 클립을 다시 만들지 않는다.
        const kept = previousByKey.get([...group.mediaIds].sort().join("|"));
        return {
          ...built,
          clip: kept?.clip ?? null,
          style: group.style ?? kept?.style ?? built.style,
          title: group.title ?? kept?.title ?? built.title,
        };
      });

      await saveGroupManifest(storage, {
        createdAt: new Date().toISOString(),
        groups,
        mode: "manual",
        projectId: request.params.id,
        schemaVersion: 2,
      });
      return groupsResponse(storage, request.params.id);
    },
  );

  /** 그룹 하나의 클립 스타일만 바꾼다. 클립은 다시 만들 때 새 스타일로 나온다. */
  app.patch<{Body: unknown; Params: {groupId: string; id: string}}>(
    "/api/projects/:id/groups/:groupId",
    async (request, reply) => {
      if (projectOrNull(request.params.id) === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const parsed = groupPatchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({error: "invalid_group_patch", issues: parsed.error.issues});
      }
      const index = await loadProjectMediaIndex(storage, request.params.id);
      if (index === null) {
        return reply.code(409).send({error: "media_index_missing"});
      }
      const manifest = await loadGroupManifest(storage, request.params.id);
      const groups = manifest?.groups ?? (await resolveGroups(request.params.id, index, storage));
      if (!groups.some((group) => group.id === request.params.groupId)) {
        return reply.code(404).send({error: "group_not_found"});
      }
      await saveGroupManifest(storage, {
        createdAt: new Date().toISOString(),
        groups: groups.map((group) =>
          group.id === request.params.groupId ? {...group, style: parsed.data.style} : group,
        ),
        mode: manifest?.mode ?? "auto",
        projectId: request.params.id,
        schemaVersion: 2,
      });
      return groupsResponse(storage, request.params.id);
    },
  );

  /** 손으로 고친 구성을 버리고 자동 묶기로 되돌린다. */
  app.post<{Params: {id: string}}>("/api/projects/:id/groups/auto", async (request, reply) => {
    if (projectOrNull(request.params.id) === null) {
      return reply.code(404).send({error: "project_not_found"});
    }
    const index = await loadProjectMediaIndex(storage, request.params.id);
    if (index === null) {
      return reply.code(409).send({error: "media_index_missing"});
    }
    const previous = await loadGroupManifest(storage, request.params.id);
    const previousByKey = new Map(
      (previous?.groups ?? []).map(
        (group) => [[...group.mediaIds].sort().join("|"), group] as const,
      ),
    );
    await saveGroupManifest(storage, {
      createdAt: new Date().toISOString(),
      groups: buildPhotoGroups(request.params.id, index.items).map((group) => {
        // 자동으로 되돌려도 사진 구성이 같은 그룹은 클립과 스타일을 그대로 쓴다.
        const kept = previousByKey.get([...group.mediaIds].sort().join("|"));
        return {...group, clip: kept?.clip ?? null, style: kept?.style ?? group.style};
      }),
      mode: "auto",
      projectId: request.params.id,
      schemaVersion: 2,
    });
    return groupsResponse(storage, request.params.id);
  });

  app.get<{Params: {id: string}}>("/api/projects/:id/video-segments", async (request, reply) => {
    if (projectOrNull(request.params.id) === null) {
      return reply.code(404).send({error: "project_not_found"});
    }
    return videoSegmentsResponse(storage, request.params.id);
  });

  app.patch<{Body: unknown; Params: {id: string; segmentId: string}}>(
    "/api/projects/:id/video-segments/:segmentId",
    async (request, reply) => {
      if (projectOrNull(request.params.id) === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const parsed = segmentPatchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({error: "invalid_segment_patch", issues: parsed.error.issues});
      }
      const manifest = await loadVideoClipManifest(storage, request.params.id);
      if (manifest === null) {
        return reply.code(409).send({error: "video_segments_missing"});
      }
      const owner = manifest.videos.find((video) =>
        video.segments.some((segment) => segment.id === request.params.segmentId),
      );
      const target = owner?.segments.find((segment) => segment.id === request.params.segmentId);
      if (owner === undefined || target === undefined) {
        return reply.code(404).send({error: "segment_not_found"});
      }
      const startSec = round2(parsed.data.startSec ?? target.startSec);
      const endSec = round2(Math.min(parsed.data.endSec ?? target.endSec, owner.durationSec));
      const rangeError = validateSegmentRange(startSec, endSec);
      if (rangeError !== null) {
        return reply.code(400).send({error: "segment_range_invalid", message: rangeError});
      }
      const moved = startSec !== target.startSec || endSec !== target.endSec;
      const next: VideoClipSegment = {
        ...target,
        // 구간을 옮기면 전에 잘라 둔 클립은 더 이상 맞지 않는다.
        clip: moved ? null : target.clip,
        durationSec: round2(endSec - startSec),
        endSec,
        selected: parsed.data.selected ?? target.selected,
        startSec,
      };
      await saveVideoClipManifest(storage, replaceSegment(manifest, next));
      return videoSegmentsResponse(storage, request.params.id);
    },
  );

  /** 자동 탐지가 놓친 구간을 사람이 직접 추가한다. */
  app.post<{Body: unknown; Params: {id: string}}>(
    "/api/projects/:id/video-segments",
    async (request, reply) => {
      if (projectOrNull(request.params.id) === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const parsed = segmentCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({error: "invalid_segment", issues: parsed.error.issues});
      }
      const manifest = await loadVideoClipManifest(storage, request.params.id);
      if (manifest === null) {
        return reply.code(409).send({error: "video_segments_missing"});
      }
      const owner = manifest.videos.find((video) => video.mediaId === parsed.data.mediaId);
      if (owner === undefined) {
        return reply.code(404).send({error: "video_not_found"});
      }
      if (owner.segments.length >= VIDEO_SEGMENT_LIMITS.maxPerVideo) {
        return reply.code(400).send({
          error: "too_many_segments",
          message: `영상 하나에는 구간을 최대 ${String(VIDEO_SEGMENT_LIMITS.maxPerVideo)}개까지 만들 수 있습니다.`,
        });
      }
      const startSec = round2(parsed.data.startSec);
      const endSec = round2(Math.min(parsed.data.endSec, owner.durationSec));
      const rangeError = validateSegmentRange(startSec, endSec);
      if (rangeError !== null) {
        return reply.code(400).send({error: "segment_range_invalid", message: rangeError});
      }
      const id = makeSegmentId(owner.mediaId, startSec, endSec);
      if (owner.segments.some((segment) => segment.id === id)) {
        return reply
          .code(409)
          .send({error: "segment_exists", message: "같은 구간이 이미 있습니다."});
      }
      const created: VideoClipSegment = {
        clip: null,
        durationSec: round2(endSec - startSec),
        endSec,
        id,
        reason: "직접 지정한 구간",
        score: 70,
        selected: true,
        source: "user",
        sourceMediaId: owner.mediaId,
        startSec,
        thumbKey: null,
      };
      await saveVideoClipManifest(storage, {
        ...manifest,
        videos: manifest.videos.map((video) =>
          video.mediaId === owner.mediaId
            ? {
                ...video,
                segments: [...video.segments, created].toSorted(
                  (left, right) => left.startSec - right.startSec,
                ),
              }
            : video,
        ),
      });
      return videoSegmentsResponse(storage, request.params.id);
    },
  );

  app.delete<{Params: {id: string; segmentId: string}}>(
    "/api/projects/:id/video-segments/:segmentId",
    async (request, reply) => {
      if (projectOrNull(request.params.id) === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const manifest = await loadVideoClipManifest(storage, request.params.id);
      if (manifest === null) {
        return reply.code(409).send({error: "video_segments_missing"});
      }
      if (
        !manifest.videos.some((video) =>
          video.segments.some((segment) => segment.id === request.params.segmentId),
        )
      ) {
        return reply.code(404).send({error: "segment_not_found"});
      }
      await saveVideoClipManifest(storage, {
        ...manifest,
        videos: manifest.videos.map((video) => ({
          ...video,
          segments: video.segments.filter((segment) => segment.id !== request.params.segmentId),
        })),
      });
      return videoSegmentsResponse(storage, request.params.id);
    },
  );

  /** 구간을 고르는 화면에서 원본(프록시)을 재생하기 위한 스트림. */
  app.get<{Params: {id: string; mediaId: string}}>(
    "/api/projects/:id/media/:mediaId/stream",
    async (request, reply) => {
      if (projectOrNull(request.params.id) === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const index = await loadProjectMediaIndex(storage, request.params.id);
      const item = index?.items.find((entry) => entry.id === request.params.mediaId);
      if (item === undefined || item.mediaType !== "video") {
        return reply.code(404).send({error: "media_not_found"});
      }
      const filePath =
        item.proxyKey === null ? item.absolutePath : await storage.localPath(item.proxyKey);
      try {
        return await streamVideo(filePath, request.headers.range, null, reply);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return reply.code(404).send({error: "media_file_missing"});
        }
        throw error;
      }
    },
  );

  app.get<{Params: {id: string}}>("/api/projects/:id/clips", async (request, reply) => {
    if (projectOrNull(request.params.id) === null) {
      return reply.code(404).send({error: "project_not_found"});
    }
    return clipsResponse(storage, request.params.id);
  });

  app.patch<{Body: unknown; Params: {clipId: string; id: string}}>(
    "/api/projects/:id/clips/:clipId",
    async (request, reply) => {
      if (projectOrNull(request.params.id) === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const parsed = clipPatchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({error: "invalid_clip_patch", issues: parsed.error.issues});
      }
      const manifest = await loadClipManifest(storage, request.params.id);
      if (manifest === null) {
        return reply.code(409).send({error: "clips_missing"});
      }
      const target = manifest.clips.find((clip) => clip.id === request.params.clipId);
      if (target === undefined) {
        return reply.code(404).send({error: "clip_not_found"});
      }
      const patch = parsed.data;
      const startSec = patch.startSec ?? target.startSec;
      const endSec = patch.endSec ?? target.endSec;
      if (endSec - startSec < 0.5) {
        return reply
          .code(400)
          .send({error: "clip_range_too_short", message: "클립은 0.5초보다 길어야 합니다."});
      }
      const next: PipelineClip = {
        ...target,
        caption:
          patch.caption === undefined
            ? target.caption
            : patch.caption === null || patch.caption.trim().length === 0
              ? null
              : {source: "user", text: patch.caption.trim()},
        durationSec: Math.round((endSec - startSec) * 100) / 100,
        endSec: target.kind === "group" ? target.endSec : endSec,
        look: patch.look ?? target.look,
        selected: patch.selected ?? target.selected,
        startSec: target.kind === "group" ? target.startSec : startSec,
        transitionIn: patch.transitionIn ?? target.transitionIn,
      };
      // 이미 잘라 낸 클립 파일을 쓰는 경우 길이는 파일이 정한다.
      const resolved: PipelineClip =
        target.kind === "group" || target.assetKey !== null
          ? {
              ...next,
              durationSec: target.durationSec,
              endSec: target.endSec,
              startSec: target.startSec,
            }
          : next;
      await saveClipManifest(storage, {
        ...manifest,
        clips: manifest.clips.map((clip) => (clip.id === resolved.id ? resolved : clip)),
      });
      return clipsResponse(storage, request.params.id);
    },
  );

  /** 모든 클립에 같은 색감 필터를 한 번에 적용한다. */
  app.post<{Body: unknown; Params: {id: string}}>(
    "/api/projects/:id/clips/look",
    async (request, reply) => {
      if (projectOrNull(request.params.id) === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const parsed = clipLookAllBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({error: "invalid_look", issues: parsed.error.issues});
      }
      const manifest = await loadClipManifest(storage, request.params.id);
      if (manifest === null) {
        return reply.code(409).send({error: "clips_missing"});
      }
      await saveClipManifest(storage, {
        ...manifest,
        clips: manifest.clips.map((clip) => ({...clip, look: parsed.data.look})),
      });
      return clipsResponse(storage, request.params.id);
    },
  );

  app.patch<{Body: unknown; Params: {id: string}}>(
    "/api/projects/:id/clips",
    async (request, reply) => {
      if (projectOrNull(request.params.id) === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const parsed = clipOrderBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({error: "invalid_clip_order", issues: parsed.error.issues});
      }
      const manifest = await loadClipManifest(storage, request.params.id);
      if (manifest === null) {
        return reply.code(409).send({error: "clips_missing"});
      }
      const position = new Map(parsed.data.order.map((clipId, index) => [clipId, index]));
      const reordered = manifest.clips
        .toSorted(
          (left, right) =>
            (position.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
            (position.get(right.id) ?? Number.MAX_SAFE_INTEGER),
        )
        .map((clip, order) => ({...clip, order}));
      await saveClipManifest(storage, {...manifest, clips: reordered});
      return clipsResponse(storage, request.params.id);
    },
  );

  app.get<{Params: {clipId: string; id: string}}>(
    "/api/projects/:id/clips/:clipId/stream",
    async (request, reply) => {
      if (projectOrNull(request.params.id) === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const manifest = await loadClipManifest(storage, request.params.id);
      const clip = manifest?.clips.find((entry) => entry.id === request.params.clipId);
      if (clip === undefined) {
        return reply.code(404).send({error: "clip_not_found"});
      }
      let filePath: string;
      if (clip.assetKey !== null) {
        filePath = await storage.localPath(clip.assetKey);
      } else {
        const index = await loadProjectMediaIndex(storage, request.params.id);
        const item = index?.items.find((entry) => entry.id === clip.sourceMediaId);
        if (item === undefined) {
          return reply.code(404).send({error: "clip_source_missing"});
        }
        filePath =
          item.proxyKey === null ? item.absolutePath : await storage.localPath(item.proxyKey);
      }
      try {
        return await streamVideo(filePath, request.headers.range, null, reply);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return reply.code(404).send({error: "clip_file_missing"});
        }
        throw error;
      }
    },
  );

  app.get<{Params: {id: string}}>("/api/projects/:id/render-plan", async (request, reply) => {
    const key = renderPlanKey(request.params.id);
    if (!(await storage.exists(key))) {
      return reply.code(404).send({error: "render_plan_not_found"});
    }
    return renderPlanSchema.parse(JSON.parse((await storage.read(key)).toString("utf8")));
  });

  app.get<{Params: {id: string}}>("/api/projects/:id/timeline-warnings", async (request) => {
    const key = timelineWarningsKey(request.params.id);
    if (!(await storage.exists(key))) {
      return {warnings: []};
    }
    return z
      .object({warnings: z.array(z.string())})
      .parse(JSON.parse((await storage.read(key)).toString("utf8")));
  });

  app.get<{Params: {id: string}}>("/api/projects/:id/music-library", async (request, reply) => {
    const key = musicLibraryKey(request.params.id);
    if (!(await storage.exists(key))) {
      return reply.code(404).send({error: "music_library_not_found"});
    }
    return musicLibrarySchema.parse(JSON.parse((await storage.read(key)).toString("utf8")));
  });

  app.get<{Params: {id: string}}>("/api/projects/:id/music-selection", async (request, reply) => {
    const key = musicSelectionKey(request.params.id);
    if (!(await storage.exists(key))) {
      return reply.code(404).send({error: "music_selection_not_found"});
    }
    return musicSelectionSchema.parse(JSON.parse((await storage.read(key)).toString("utf8")));
  });

  app.get<{Params: {id: string; trackId: string}}>(
    "/api/projects/:id/music/tracks/:trackId/audio",
    async (request, reply) => {
      if (musicRoot === undefined) {
        return reply.code(503).send({error: "music_services_unavailable"});
      }
      const key = musicLibraryKey(request.params.id);
      if (!(await storage.exists(key))) {
        return reply.code(404).send({error: "music_library_not_found"});
      }
      const library = musicLibrarySchema.parse(
        JSON.parse((await storage.read(key)).toString("utf8")),
      );
      const track = library.tracks.find((entry) => entry.id === request.params.trackId);
      if (track === undefined) {
        return reply.code(404).send({error: "track_not_found"});
      }
      try {
        const filePath = resolveMusicTrackPath(musicRoot, track.path);
        const info = await stat(filePath);
        return reply
          .type("audio/mpeg")
          .header("Content-Length", String(info.size))
          .send(createReadStream(filePath));
      } catch {
        return reply.code(404).send({error: "track_file_not_found"});
      }
    },
  );

  app.get<{Params: {id: string}}>("/api/projects/:id/render-result", async (request, reply) => {
    const project = projectOrNull(request.params.id);
    if (project === null) {
      return reply.code(404).send({error: "project_not_found"});
    }
    const statuses = getStepStatuses(database, project.id);
    const intermediateReady =
      stepDone(statuses.render) && (await storage.exists(intermediateVideoKey(project.id)));
    let report = null;
    let finalReady = false;
    if (finalizer !== undefined) {
      const reportKey = finalizer.reportKey(project.id);
      report = (await storage.exists(reportKey))
        ? verifyReportSchema.parse(JSON.parse((await storage.read(reportKey)).toString("utf8")))
        : null;
      finalReady =
        stepDone(statuses.finalize) &&
        (await stat(finalizer.outputPath(project.id)).then(
          (info) => info.isFile() && info.size > 0,
          () => false,
        ));
    }
    const base = `/api/projects/${encodeURIComponent(project.id)}/videos`;
    return {
      finalReady,
      finalUrl: finalReady ? `${base}/final` : null,
      intermediateReady,
      intermediateUrl: intermediateReady ? `${base}/intermediate` : null,
      report,
    };
  });

  app.get<{Params: {id: string; kind: string}; Querystring: {download?: string}}>(
    "/api/projects/:id/videos/:kind",
    async (request, reply) => {
      const project = projectOrNull(request.params.id);
      if (project === null) {
        return reply.code(404).send({error: "project_not_found"});
      }
      const kind = z.enum(["intermediate", "final"]).safeParse(request.params.kind);
      if (!kind.success) {
        return reply.code(404).send({error: "video_not_found"});
      }
      if (kind.data === "final" && finalizer === undefined) {
        return reply.code(503).send({error: "finalize_service_unavailable"});
      }
      const filePath =
        kind.data === "intermediate"
          ? await storage.localPath(intermediateVideoKey(project.id))
          : finalizer!.outputPath(project.id);
      try {
        return await streamVideo(
          filePath,
          request.headers.range,
          request.query.download === "1" ? `${project.title || "movie"}.mp4` : null,
          reply,
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return reply.code(404).send({error: "video_not_found"});
        }
        throw error;
      }
    },
  );

  app.get("/api/system/ffmpeg-status", async () => ({
    available: probe !== undefined && transcoder !== undefined,
    error:
      probe !== undefined && transcoder !== undefined
        ? null
        : "FFmpeg / FFprobe 실행 파일을 찾지 못했습니다.",
  }));
};
