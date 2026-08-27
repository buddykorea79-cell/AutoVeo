import {createHash} from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import {
  clipManifestSchema,
  pipelineClipSchema,
  type ClipManifest,
  type MediaItem,
  type PhotoGroup,
  type PipelineClip,
} from "@travel-movie/schema";

import type {Step, StepContext} from "../jobs/job-runner.js";
import type {MediaTranscoder} from "../services/ffmpeg.js";
import type {ClipAiProposal, OllamaService} from "../services/ollama.js";
import {getAdminSettings} from "../services/admin-settings.js";
import {analyzeCandidateQuality, extractFramesForQuality} from "../services/video-quality.js";
import type {CandidateSegment} from "../services/video-scene.js";
import {loadProjectMediaIndex} from "../services/web-projects.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";
import {loadGroupManifest} from "./group-clips.js";
import {extractedVideoClips, loadVideoClipManifest} from "./video-clips.js";

/**
 * v2: 촬영 영상의 구간 찾기는 detect-video-segments / extract-video-clips 로 옮겼다.
 * v3: AI 가 쓸 만한 클립만 골라 추천하고, 프레임을 줄여 보낸다.
 */
export const ANALYZE_CLIPS_CODE_VERSION = 3;

/** 이 점수 이상이면 최종 영상에 쓸 만하다고 본다. */
export const RECOMMEND_MIN_SCORE = 72;
/** 점수가 모두 낮아도 최소 이만큼은 추천해 영상이 비지 않게 한다. */
export const RECOMMEND_MIN_COUNT = 3;

/**
 * 점수를 기준으로 최종 영상에 쓸 클립을 골라 준다.
 * 사람이 이미 넣기/빼기를 정한 클립은 그 결정을 그대로 둔다.
 */
export const recommendClipIds = (
  clips: readonly {readonly id: string; readonly score: number}[],
): ReadonlySet<string> => {
  const ranked = clips.toSorted((left, right) => right.score - left.score);
  const passing = ranked.filter((clip) => clip.score >= RECOMMEND_MIN_SCORE);
  const chosen =
    passing.length >= RECOMMEND_MIN_COUNT ? passing : ranked.slice(0, RECOMMEND_MIN_COUNT);
  return new Set(chosen.map((clip) => clip.id));
};

export interface AnalyzeClipsDependencies {
  readonly database: BetterSqlite3.Database;
  readonly ollama?: OllamaService;
  readonly storage: StorageAdapter;
  readonly transcoder: MediaTranscoder;
}

export const clipManifestKey = (projectId: string): string => `manifests/${projectId}/clips.json`;

export const loadClipManifest = async (
  storage: StorageAdapter,
  projectId: string,
): Promise<ClipManifest | null> => {
  const key = clipManifestKey(projectId);
  if (!(await storage.exists(key))) {
    return null;
  }
  return clipManifestSchema.parse(JSON.parse((await storage.read(key)).toString("utf8")));
};

export const saveClipManifest = async (
  storage: StorageAdapter,
  manifest: ClipManifest,
): Promise<ClipManifest> => {
  const parsed = clipManifestSchema.parse(manifest);
  await storage.write(
    clipManifestKey(parsed.projectId),
    Buffer.from(JSON.stringify(parsed, null, 2)),
  );
  return parsed;
};

export const analyzeClipsInputHash = async (
  projectId: string,
  dependencies: Pick<AnalyzeClipsDependencies, "database" | "storage">,
): Promise<string> => {
  const index = await loadProjectMediaIndex(dependencies.storage, projectId);
  if (index === null) {
    throw new Error("먼저 원본을 불러오세요.");
  }
  const groups = await loadGroupManifest(dependencies.storage, projectId);
  const videoClips = await loadVideoClipManifest(dependencies.storage, projectId);
  const settings = getAdminSettings(dependencies.database);
  return createHash("sha1")
    .update(
      JSON.stringify({
        groups: (groups?.groups ?? []).map((group) => ({
          clip: group.clip?.inputHash ?? null,
          id: group.id,
        })),
        model: settings.ollamaModel,
        version: ANALYZE_CLIPS_CODE_VERSION,
        videoClips: extractedVideoClips(videoClips).map(({segment}) => segment.clip!.inputHash),
      }),
    )
    .digest("hex");
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const heuristicScore = (quality: {
  brightness: number;
  motion: number;
  sharpness: number;
  stability: number;
}): number =>
  Math.round(
    clamp01(
      quality.sharpness * 0.35 +
        quality.brightness * 0.25 +
        quality.stability * 0.25 +
        quality.motion * 0.15,
    ) *
      40 +
      55,
  );

const resolveVisionModel = async (
  dependencies: AnalyzeClipsDependencies,
  signal: AbortSignal,
): Promise<string | null> => {
  if (dependencies.ollama === undefined) {
    return null;
  }
  const configured = getAdminSettings(dependencies.database).ollamaModel;
  const list = await dependencies.ollama.listModels(signal);
  if (!list.available) {
    return null;
  }
  const vision = list.models.filter((model) => model.vision);
  if (configured !== null && vision.some((model) => model.name === configured)) {
    return configured;
  }
  return vision[0]?.name ?? null;
};

const pickSpread = <T>(values: readonly T[], count: number): T[] => {
  if (values.length <= count) {
    return [...values];
  }
  const step = values.length / count;
  return Array.from({length: count}, (_, index) => values[Math.floor(index * step)]!);
};

export const createAnalyzeClipsStep = (
  projectId: string,
  dependencies: AnalyzeClipsDependencies,
): Step => ({
  codeVersion: ANALYZE_CLIPS_CODE_VERSION,
  invalidates: ["assemble", "timeline", "music", "render", "finalize"],
  name: "analyze-clips",
  outputRef: () => clipManifestKey(projectId),
  run: async (context: StepContext) => {
    const index = await loadProjectMediaIndex(dependencies.storage, projectId);
    if (index === null) {
      throw new Error("먼저 원본을 불러오세요.");
    }
    const groupManifest = await loadGroupManifest(dependencies.storage, projectId);
    const groups = (groupManifest?.groups ?? []).filter(
      (group): group is PhotoGroup & {clip: NonNullable<PhotoGroup["clip"]>} => group.clip !== null,
    );
    const videoClips = extractedVideoClips(
      await loadVideoClipManifest(dependencies.storage, projectId),
    );

    if (groups.length === 0 && videoClips.length === 0) {
      throw new Error("분석할 클립이 없습니다. 그룹 클립을 만들거나 영상에서 클립을 잘라 내세요.");
    }

    const previous = await loadClipManifest(dependencies.storage, projectId);
    const previousById = new Map((previous?.clips ?? []).map((clip) => [clip.id, clip]));

    const model = await resolveVisionModel(dependencies, context.signal);
    context.report({
      message:
        model === null
          ? "AI 모델이 없어 화질 기반으로 평가합니다"
          : `AI 모델 ${model} 로 클립을 평가합니다`,
      progress: 0.03,
    });

    const totalUnits = groups.length + videoClips.length;
    let unitsDone = 0;
    const clips: PipelineClip[] = [];

    const askAi = async (
      localPath: string,
      range: CandidateSegment,
      title: string,
      kind: "group" | "source",
    ): Promise<ClipAiProposal | null> => {
      if (model === null || dependencies.ollama === undefined) {
        return null;
      }
      try {
        const frames = await extractFramesForQuality(
          localPath,
          range.start,
          range.end,
          dependencies.transcoder,
          context.signal,
        );
        if (frames.length === 0) {
          return null;
        }
        return await dependencies.ollama.analyzeClip(
          {
            durationSec: range.end - range.start,
            imageBuffers: pickSpread(frames, 3),
            kind,
            model,
            title,
          },
          context.signal,
        );
      } catch (error) {
        console.warn(`[analyze-clips] AI 분석 실패 (${title}): ${String(error)}`);
        return null;
      }
    };

    const measureQuality = async (
      localPath: string,
      range: CandidateSegment,
      fallback: {brightness: number; motion: number; sharpness: number; stability: number},
    ): Promise<typeof fallback> => {
      try {
        return await analyzeCandidateQuality(
          await extractFramesForQuality(
            localPath,
            range.start,
            range.end,
            dependencies.transcoder,
            context.signal,
          ),
        );
      } catch {
        return fallback;
      }
    };

    // 1) 사진 그룹으로 만든 클립
    for (const group of groups) {
      if (context.signal.aborted) {
        throw new Error("클립 분석이 취소되었습니다.");
      }
      context.report({
        message: `그룹 클립 평가 중 — ${group.title}`,
        progress: 0.03 + (unitsDone / totalUnits) * 0.94,
      });
      const localPath = await dependencies.storage.localPath(group.clip.assetKey);
      const range: CandidateSegment = {end: group.clip.durationSec, start: 0};
      const quality = await measureQuality(localPath, range, {
        brightness: 0.6,
        motion: 0.5,
        sharpness: 0.6,
        stability: 0.8,
      });
      const proposal = await askAi(localPath, range, group.title, "group");
      const id = `clip_${group.id}`;
      const kept = previousById.get(id);
      clips.push(
        pipelineClipSchema.parse({
          analysis: {
            aiUsed: proposal !== null,
            category: proposal?.category ?? "static_beauty",
            description:
              proposal?.description ?? `사진 ${String(group.mediaIds.length)}장으로 만든 장면`,
            score: proposal?.score ?? heuristicScore(quality),
            tags: proposal?.tags ?? [],
          },
          assetKey: group.clip.assetKey,
          caption:
            kept?.caption?.source === "user"
              ? kept.caption
              : proposal === null
                ? null
                : {source: "ai", text: proposal.caption},
          durationSec: group.clip.durationSec,
          endSec: group.clip.durationSec,
          groupId: group.id,
          id,
          kind: "group",
          look: kept?.look ?? "none",
          mediaIds: group.mediaIds,
          order: kept?.order ?? clips.length,
          selected: false,
          sourceMediaId: null,
          startSec: 0,
          thumbKey: group.clip.thumbKey,
          title: group.title,
          transitionIn: kept?.transitionIn ?? "crossfade",
        }),
      );
      unitsDone += 1;
    }

    // 2) 촬영 영상에서 잘라 낸 클립
    for (const {segment, video} of videoClips) {
      if (context.signal.aborted) {
        throw new Error("클립 분석이 취소되었습니다.");
      }
      const clip = segment.clip!;
      context.report({
        message: `영상 클립 평가 중 — ${video.filename}`,
        progress: 0.03 + (unitsDone / totalUnits) * 0.94,
      });
      const localPath = await dependencies.storage.localPath(clip.assetKey);
      const range: CandidateSegment = {end: clip.durationSec, start: 0};
      const quality = await measureQuality(localPath, range, {
        brightness: 0.6,
        motion: 0.5,
        sharpness: 0.6,
        stability: 0.6,
      });
      const title = `${video.filename} · ${segment.startSec.toFixed(0)}s`;
      const proposal = await askAi(localPath, range, title, "source");
      const id = `clip_${segment.id}`;
      const kept = previousById.get(id);
      clips.push(
        pipelineClipSchema.parse({
          analysis: {
            aiUsed: proposal !== null,
            category: proposal?.category ?? "general",
            description:
              proposal?.description ??
              `${video.filename} ${segment.startSec.toFixed(1)}초 구간 · ${segment.reason}`,
            score: proposal?.score ?? Math.max(segment.score, heuristicScore(quality)),
            tags: proposal?.tags ?? [],
          },
          assetKey: clip.assetKey,
          caption:
            kept?.caption?.source === "user"
              ? kept.caption
              : proposal === null
                ? null
                : {source: "ai", text: proposal.caption},
          durationSec: clip.durationSec,
          endSec: clip.durationSec,
          groupId: null,
          id,
          kind: "source",
          look: kept?.look ?? "none",
          mediaIds: [video.mediaId],
          order: kept?.order ?? clips.length,
          selected: false,
          sourceMediaId: video.mediaId,
          startSec: 0,
          thumbKey: clip.thumbKey ?? segment.thumbKey,
          title,
          transitionIn: kept?.transitionIn ?? "crossfade",
        }),
      );
      unitsDone += 1;
    }

    // 점수를 다 매긴 뒤에 쓸 만한 클립을 추천한다.
    // 사람이 이미 넣기/빼기를 누른 클립은 그 결정을 덮어쓰지 않는다.
    const recommended = recommendClipIds(
      clips.map((clip) => ({id: clip.id, score: clip.analysis.score})),
    );
    const decided = clips.map((clip) => ({
      ...clip,
      selected: previousById.get(clip.id)?.selected ?? recommended.has(clip.id),
    }));

    // 촬영 시간 순서를 기본 순서로 삼되, 사용자가 정한 순서가 있으면 유지한다.
    const ordered = decided
      .toSorted((left, right) => left.order - right.order)
      .map((clip, order) => ({...clip, order}));

    const manifest = await saveClipManifest(dependencies.storage, {
      clips: ordered,
      createdAt: new Date().toISOString(),
      projectId,
      schemaVersion: 2,
    });
    context.report({message: "클립 분석 완료", progress: 1});
    return {aiUsed: model !== null, clips: manifest.clips.length};
  },
});

export const clipMediaTitle = (item: MediaItem): string => item.filename;
