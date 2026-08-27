import {createHash} from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import {
  VIDEO_SEGMENT_LIMITS,
  videoClipManifestSchema,
  type MediaIndex,
  type MediaItem,
  type VideoClipManifest,
  type VideoClipSegment,
  type VideoClipSource,
} from "@travel-movie/schema";

import type {Step, StepContext} from "../jobs/job-runner.js";
import {composeClipThumbnail, composeVideoSegmentClip} from "../services/clip-composer.js";
import type {MediaProbe} from "../services/ffprobe.js";
import type {MediaTranscoder} from "../services/ffmpeg.js";
import {
  outputDimensions,
  renderTargetLongEdgePx,
  type OutputAspect,
  type OutputResolution,
} from "../services/output-format.js";
import {analyzeCandidateQuality, extractFramesForQuality} from "../services/video-quality.js";
import {
  extractMotionHints,
  generateCandidateSegments,
  refineCandidatesWithMotion,
  type CandidateSegment,
} from "../services/video-scene.js";
import {loadProjectMediaIndex, projectManifestKey} from "../services/web-projects.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";
import {PREPARE_CODE_VERSION, prepareMedia} from "./prepare.js";

export const DETECT_VIDEO_SEGMENTS_CODE_VERSION = 1;
export const EXTRACT_VIDEO_CLIPS_CODE_VERSION = 1;

export interface VideoClipsParams {
  readonly aspect: OutputAspect;
  readonly fps: 24 | 30 | 60;
  readonly resolution: OutputResolution;
}

export interface VideoClipsDependencies {
  readonly database: BetterSqlite3.Database;
  readonly probe: MediaProbe;
  readonly storage: StorageAdapter;
  readonly transcoder: MediaTranscoder;
}

export const videoClipManifestKey = (projectId: string): string =>
  `manifests/${projectId}/video-clips.json`;

export const loadVideoClipManifest = async (
  storage: StorageAdapter,
  projectId: string,
): Promise<VideoClipManifest | null> => {
  const key = videoClipManifestKey(projectId);
  if (!(await storage.exists(key))) {
    return null;
  }
  return videoClipManifestSchema.parse(JSON.parse((await storage.read(key)).toString("utf8")));
};

export const saveVideoClipManifest = async (
  storage: StorageAdapter,
  manifest: VideoClipManifest,
): Promise<VideoClipManifest> => {
  const parsed = videoClipManifestSchema.parse(manifest);
  await storage.write(
    videoClipManifestKey(parsed.projectId),
    Buffer.from(JSON.stringify(parsed, null, 2)),
  );
  return parsed;
};

export const eligibleVideoItems = (index: MediaIndex): MediaItem[] =>
  index.items
    .filter(
      (item) =>
        item.mediaType === "video" &&
        item.userDecision !== "exclude" &&
        (item.video?.durationSec ?? 0) > VIDEO_SEGMENT_LIMITS.minSec,
    )
    .toSorted((left, right) => left.capturedAtLocal.localeCompare(right.capturedAtLocal));

/** 분석은 시간축이 같은 프록시로 한다. 4K 원본에서 프레임을 반복해 뽑지 않는다. */
const analysisPathFor = async (item: MediaItem, storage: StorageAdapter): Promise<string> =>
  item.proxyKey !== null && (await storage.exists(item.proxyKey))
    ? storage.localPath(item.proxyKey)
    : item.absolutePath;

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

const describeQuality = (quality: {
  brightness: number;
  motion: number;
  sharpness: number;
  stability: number;
}): string => {
  const notes: string[] = [];
  notes.push(quality.sharpness >= 0.6 ? "선명함" : quality.sharpness >= 0.4 ? "보통" : "흐릿함");
  notes.push(quality.brightness >= 0.7 ? "밝기 좋음" : "밝기 아쉬움");
  notes.push(quality.stability >= 0.7 ? "흔들림 적음" : "흔들림 있음");
  notes.push(quality.motion >= 0.6 ? "움직임 좋음" : "움직임 적음");
  return notes.join(" · ");
};

const overlaps = (left: CandidateSegment, right: CandidateSegment): boolean => {
  const shared = Math.min(left.end, right.end) - Math.max(left.start, right.start);
  const shortest = Math.min(left.end - left.start, right.end - right.start);
  return shared > 0 && shared / Math.max(1, shortest) > 0.4;
};

const pickSpread = <T>(values: readonly T[], count: number): T[] => {
  if (values.length <= count) {
    return [...values];
  }
  const step = values.length / count;
  return Array.from({length: count}, (_, index) => values[Math.floor(index * step)]!);
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

export const segmentId = (mediaId: string, startSec: number, endSec: number): string =>
  `vseg_${mediaId}_${createHash("sha1")
    .update(`${startSec.toFixed(2)}-${endSec.toFixed(2)}`)
    .digest("hex")
    .slice(0, 8)}`;

export const detectVideoSegmentsInputHash = async (
  projectId: string,
  storage: StorageAdapter,
): Promise<string> => {
  const index = await loadProjectMediaIndex(storage, projectId);
  if (index === null) {
    throw new Error("먼저 원본을 불러오세요.");
  }
  return createHash("sha1")
    .update(
      JSON.stringify({
        version: DETECT_VIDEO_SEGMENTS_CODE_VERSION,
        videos: eligibleVideoItems(index).map((item) => item.contentHash),
      }),
    )
    .digest("hex");
};

/**
 * 1단계: 촬영 영상에서 쓸 만한 구간을 자동으로 찾는다.
 * 이 단계는 파일을 만들지 않는다. 사람이 화면에서 확인하고 고른 뒤에 잘라 낸다.
 */
export const createDetectVideoSegmentsStep = (
  projectId: string,
  dependencies: Pick<VideoClipsDependencies, "storage" | "transcoder">,
): Step => ({
  codeVersion: DETECT_VIDEO_SEGMENTS_CODE_VERSION,
  invalidates: ["extract-video-clips", "analyze-clips", "assemble", "timeline", "render"],
  name: "detect-video-segments",
  outputRef: () => videoClipManifestKey(projectId),
  run: async (context: StepContext) => {
    const index = await loadProjectMediaIndex(dependencies.storage, projectId);
    if (index === null) {
      throw new Error("먼저 원본을 불러오세요.");
    }
    const videos = eligibleVideoItems(index);
    if (videos.length === 0) {
      // 영상이 없는 프로젝트도 정상이다. 빈 목록을 남기고 다음 단계로 넘긴다.
      await saveVideoClipManifest(dependencies.storage, {
        createdAt: new Date().toISOString(),
        projectId,
        schemaVersion: 2,
        videos: [],
      });
      context.report({message: "촬영 영상이 없습니다", progress: 1});
      return {segments: 0, videos: 0};
    }

    const previous = await loadVideoClipManifest(dependencies.storage, projectId);
    const previousByMedia = new Map(
      (previous?.videos ?? []).map((entry) => [entry.mediaId, entry] as const),
    );

    const built: VideoClipSource[] = [];
    let done = 0;
    for (const video of videos) {
      if (context.signal.aborted) {
        throw new Error("영상 구간 찾기가 취소되었습니다.");
      }
      const duration = video.video?.durationSec ?? 0;
      context.report({
        message: `좋은 구간을 찾는 중 — ${video.filename}`,
        progress: 0.02 + (done / videos.length) * 0.96,
      });

      const analysisPath = await analysisPathFor(video, dependencies.storage);
      let motionHints: number[];
      try {
        motionHints = await extractMotionHints(
          analysisPath,
          duration,
          dependencies.transcoder,
          context.signal,
        );
      } catch {
        motionHints = [];
      }
      const candidates = pickSpread(
        refineCandidatesWithMotion(
          generateCandidateSegments(duration, motionHints),
          motionHints,
          duration,
        ),
        8,
      );

      const scored: {candidate: CandidateSegment; reason: string; score: number}[] = [];
      for (const candidate of candidates) {
        let quality = {brightness: 0.6, motion: 0.5, sharpness: 0.6, stability: 0.6};
        try {
          quality = await analyzeCandidateQuality(
            await extractFramesForQuality(
              analysisPath,
              candidate.start,
              candidate.end,
              dependencies.transcoder,
              context.signal,
            ),
          );
        } catch {
          // 화질을 못 재면 기본값으로 계속 진행한다.
        }
        scored.push({
          candidate,
          reason: describeQuality(quality),
          score: heuristicScore(quality),
        });
      }

      const chosen: typeof scored = [];
      for (const entry of scored.toSorted((left, right) => right.score - left.score)) {
        if (chosen.some((other) => overlaps(other.candidate, entry.candidate))) {
          continue;
        }
        chosen.push(entry);
        if (chosen.length >= VIDEO_SEGMENT_LIMITS.maxPerVideo) {
          break;
        }
      }
      const ranked = chosen.toSorted((left, right) => right.score - left.score);
      const recommended = new Set(
        ranked.slice(0, VIDEO_SEGMENT_LIMITS.autoPerVideo).map((entry) => entry.candidate),
      );

      const keptUserSegments = (previousByMedia.get(video.id)?.segments ?? []).filter(
        (segment) => segment.source === "user",
      );
      const previousSelection = new Map(
        (previousByMedia.get(video.id)?.segments ?? []).map(
          (segment) => [segment.id, segment] as const,
        ),
      );

      const autoSegments: VideoClipSegment[] = chosen
        .toSorted((left, right) => left.candidate.start - right.candidate.start)
        .map((entry) => {
          const startSec = round2(entry.candidate.start);
          const endSec = round2(Math.min(entry.candidate.end, duration));
          const id = segmentId(video.id, startSec, endSec);
          const kept = previousSelection.get(id);
          return {
            // 이미 잘라 둔 클립이 있으면 그대로 재사용한다.
            clip: kept?.clip ?? null,
            durationSec: round2(endSec - startSec),
            endSec,
            id,
            reason: entry.reason,
            score: entry.score,
            selected: kept?.selected ?? recommended.has(entry.candidate),
            source: "auto" as const,
            sourceMediaId: video.id,
            startSec,
            thumbKey: kept?.thumbKey ?? null,
          };
        });

      built.push({
        capturedAtLocal: video.capturedAtLocal,
        durationSec: duration,
        filename: video.filename,
        mediaId: video.id,
        // 사람이 직접 추가한 구간은 자동 탐지가 지우지 않는다.
        segments: [...autoSegments, ...keptUserSegments].toSorted(
          (left, right) => left.startSec - right.startSec,
        ),
      });
      done += 1;
    }

    // 미리보기 썸네일은 사람이 구간을 고를 때 필요하므로 여기서 만든다.
    let thumbsDone = 0;
    const totalSegments = built.reduce((sum, entry) => sum + entry.segments.length, 0);
    const withThumbs: VideoClipSource[] = [];
    for (const entry of built) {
      const item = videos.find((video) => video.id === entry.mediaId)!;
      const analysisPath = await analysisPathFor(item, dependencies.storage);
      const segments: VideoClipSegment[] = [];
      for (const segment of entry.segments) {
        thumbsDone += 1;
        if (segment.thumbKey !== null && (await dependencies.storage.exists(segment.thumbKey))) {
          segments.push(segment);
          continue;
        }
        context.report({
          message: `구간 미리보기 ${String(thumbsDone)} / ${String(totalSegments)}`,
          progress: 0.02 + (thumbsDone / Math.max(1, totalSegments)) * 0.96,
        });
        let thumbKey: string | null;
        try {
          thumbKey = await composeClipThumbnail(
            analysisPath,
            segment.startSec + segment.durationSec * 0.35,
            `clips/${projectId}/${segment.id}.webp`,
            dependencies.storage,
            dependencies.transcoder,
            context.signal,
          );
        } catch {
          thumbKey = null;
        }
        segments.push({...segment, thumbKey});
      }
      withThumbs.push({...entry, segments});
    }

    const manifest = await saveVideoClipManifest(dependencies.storage, {
      createdAt: new Date().toISOString(),
      projectId,
      schemaVersion: 2,
      videos: withThumbs,
    });
    context.report({message: "쓸 만한 구간을 찾았습니다", progress: 1});
    return {
      segments: manifest.videos.reduce((sum, entry) => sum + entry.segments.length, 0),
      videos: manifest.videos.length,
    };
  },
});

const segmentFingerprint = (
  segment: VideoClipSegment,
  contentHash: string,
  params: VideoClipsParams,
): string =>
  createHash("sha1")
    .update(
      JSON.stringify({
        contentHash,
        endSec: segment.endSec,
        params,
        startSec: segment.startSec,
        version: EXTRACT_VIDEO_CLIPS_CODE_VERSION,
      }),
    )
    .digest("hex");

export const extractVideoClipsInputHash = async (
  projectId: string,
  storage: StorageAdapter,
  params: VideoClipsParams,
): Promise<string> => {
  const manifest = await loadVideoClipManifest(storage, projectId);
  if (manifest === null) {
    throw new Error("먼저 영상에서 좋은 구간을 찾으세요.");
  }
  const index = await loadProjectMediaIndex(storage, projectId);
  if (index === null) {
    throw new Error("먼저 원본을 불러오세요.");
  }
  const hashById = new Map(index.items.map((item) => [item.id, item.contentHash] as const));
  return createHash("sha1")
    .update(
      JSON.stringify({
        prepare: PREPARE_CODE_VERSION,
        segments: manifest.videos.flatMap((entry) =>
          entry.segments
            .filter((segment) => segment.selected)
            .map((segment) =>
              segmentFingerprint(segment, hashById.get(entry.mediaId) ?? entry.mediaId, params),
            ),
        ),
        version: EXTRACT_VIDEO_CLIPS_CODE_VERSION,
      }),
    )
    .digest("hex");
};

/** 2단계: 사람이 고른 구간만 실제 mp4 클립으로 잘라 낸다. */
export const createExtractVideoClipsStep = (
  projectId: string,
  params: VideoClipsParams,
  dependencies: VideoClipsDependencies,
  force: boolean,
): Step => ({
  codeVersion: EXTRACT_VIDEO_CLIPS_CODE_VERSION,
  invalidates: ["analyze-clips", "assemble", "timeline", "music", "render", "finalize"],
  name: "extract-video-clips",
  outputRef: () => videoClipManifestKey(projectId),
  run: async (context: StepContext) => {
    const manifest = await loadVideoClipManifest(dependencies.storage, projectId);
    if (manifest === null) {
      throw new Error("먼저 영상에서 좋은 구간을 찾으세요.");
    }
    const index = await loadProjectMediaIndex(dependencies.storage, projectId);
    if (index === null) {
      throw new Error("먼저 원본을 불러오세요.");
    }
    const selectedCount = manifest.videos.reduce(
      (sum, entry) => sum + entry.segments.filter((segment) => segment.selected).length,
      0,
    );
    if (selectedCount === 0) {
      throw new Error("클립으로 만들 구간을 최소 한 개 선택하세요.");
    }

    const usedMediaIds = manifest.videos
      .filter((entry) => entry.segments.some((segment) => segment.selected))
      .map((entry) => entry.mediaId);
    context.report({message: "영상의 렌더 파일을 준비하는 중", progress: 0.04});
    const prepared = await prepareMedia(
      index,
      {
        force: false,
        mediaIds: usedMediaIds,
        renderTargetLongEdgePx: renderTargetLongEdgePx(params.resolution),
        signal: context.signal,
        stages: ["render"],
      },
      {
        database: dependencies.database,
        manifestKey: projectManifestKey(projectId),
        onProgress: ({completed, total}) =>
          context.report({
            message: `렌더 파일 ${String(completed)} / ${String(total)}`,
            progress: 0.04 + (total === 0 ? 0.26 : (completed / total) * 0.26),
          }),
        probe: dependencies.probe,
        storage: dependencies.storage,
        transcoder: dependencies.transcoder,
      },
    );

    const dimensions = outputDimensions(params);
    const itemById = new Map(prepared.index.items.map((item) => [item.id, item] as const));
    const built: VideoClipSource[] = [];
    let done = 0;

    for (const entry of manifest.videos) {
      const item = itemById.get(entry.mediaId);
      const segments: VideoClipSegment[] = [];
      for (const segment of entry.segments) {
        if (context.signal.aborted) {
          throw new Error("클립 만들기가 취소되었습니다.");
        }
        if (!segment.selected) {
          // 고르지 않은 구간은 만들지 않는다. 이전에 만든 파일은 그대로 둔다.
          segments.push(segment);
          continue;
        }
        if (item === undefined) {
          throw new Error(`영상의 원본을 찾을 수 없습니다: ${entry.filename}`);
        }
        const fingerprint = segmentFingerprint(segment, item.contentHash, params);
        if (
          !force &&
          segment.clip !== null &&
          segment.clip.inputHash === fingerprint &&
          (await dependencies.storage.exists(segment.clip.assetKey))
        ) {
          segments.push(segment);
          done += 1;
          context.report({
            message: `클립 재사용 ${String(done)} / ${String(selectedCount)}`,
            progress: 0.3 + (done / selectedCount) * 0.7,
          });
          continue;
        }

        context.report({
          message: `클립 만드는 중 ${String(done + 1)} / ${String(selectedCount)} — ${entry.filename}`,
          progress: 0.3 + (done / selectedCount) * 0.7,
        });

        const sourceKey = item.renderAssetKey ?? item.proxyKey;
        if (sourceKey === null) {
          throw new Error(`렌더 파일이 준비되지 않았습니다: ${item.filename}`);
        }
        const assetKey = `clips/${projectId}/${segment.id}-${fingerprint.slice(0, 8)}.mp4`;
        const composed = await composeVideoSegmentClip(
          {
            endSec: segment.endSec,
            fps: params.fps,
            height: dimensions.height,
            sourcePath: await dependencies.storage.localPath(sourceKey),
            startSec: segment.startSec,
            width: dimensions.width,
          },
          assetKey,
          dependencies.storage,
          dependencies.transcoder,
          dependencies.probe,
          context.signal,
        );

        let thumbKey: string | null = segment.thumbKey;
        try {
          thumbKey = await composeClipThumbnail(
            await dependencies.storage.localPath(assetKey),
            composed.durationSec * 0.35,
            `clips/${projectId}/${segment.id}-clip.webp`,
            dependencies.storage,
            dependencies.transcoder,
            context.signal,
          );
        } catch {
          // 썸네일은 없어도 파이프라인을 멈추지 않는다.
        }

        segments.push({
          ...segment,
          clip: {
            assetKey,
            createdAt: new Date().toISOString(),
            durationSec: composed.durationSec,
            inputHash: fingerprint,
            thumbKey,
          },
          thumbKey,
        });
        done += 1;
        context.report({
          message: `클립 완성 ${String(done)} / ${String(selectedCount)}`,
          progress: 0.3 + (done / selectedCount) * 0.7,
        });
      }
      built.push({...entry, segments});
    }

    const saved = await saveVideoClipManifest(dependencies.storage, {
      ...manifest,
      createdAt: new Date().toISOString(),
      videos: built,
    });
    context.report({message: "영상 클립 준비 완료", progress: 1});
    return {
      clips: saved.videos.reduce(
        (sum, entry) => sum + entry.segments.filter((segment) => segment.clip !== null).length,
        0,
      ),
    };
  },
});

/** 타임라인에 넣을 수 있는, 실제 파일이 만들어진 구간만 돌려준다. */
export const extractedVideoClips = (
  manifest: VideoClipManifest | null,
): {readonly segment: VideoClipSegment; readonly video: VideoClipSource}[] =>
  (manifest?.videos ?? []).flatMap((video) =>
    video.segments
      .filter((segment) => segment.selected && segment.clip !== null)
      .map((segment) => ({segment, video})),
  );
