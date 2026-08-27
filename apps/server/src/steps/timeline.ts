import {createHash} from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import {framesFromSeconds, layoutScenes} from "@travel-movie/core";
import {
  renderPlanSchema,
  type MediaIndex,
  type MediaItem,
  type PhotoMotion,
  type Project,
  type ProjectScene,
  type RenderPlan,
  type RenderScene,
  type SubtitleManifest,
} from "@travel-movie/schema";

import type {Step} from "../jobs/job-runner.js";
import type {MediaTranscoder} from "../services/ffmpeg.js";
import type {MediaProbe} from "../services/ffprobe.js";
import {outputDimensions, renderTargetLongEdgePx} from "../services/output-format.js";
import {
  loadProjectMediaIndex,
  projectManifestKey,
  updateTimelineConfirmation,
} from "../services/web-projects.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";
import {PREPARE_CODE_VERSION, prepareMedia} from "./prepare.js";
import {loadProjectDocument, planSubtitles} from "./subtitle.js";

export const TIMELINE_CODE_VERSION = 7;

interface TimelineDependencies {
  readonly database: BetterSqlite3.Database;
  readonly probe: MediaProbe;
  readonly storage: StorageAdapter;
  readonly transcoder: MediaTranscoder;
}

interface PlannedRenderScene {
  readonly durationSec: number;
  readonly id: string;
  readonly item: MediaItem;
  readonly overrideAssetKey: string | null;
  readonly projectScene: ProjectScene;
  readonly transitionIn: {
    readonly durationSec: number;
    readonly type: ProjectScene["transitionIn"];
  };
}

export interface TimelineBuildResult {
  readonly plan: RenderPlan;
  readonly warnings: readonly string[];
}

export const renderPlanKey = (projectId: string): string => `plans/${projectId}/render-plan.json`;
export const timelineWarningsKey = (projectId: string): string =>
  `plans/${projectId}/timeline-warnings.json`;

const TRANSITION_SEC = 0.4;

const NO_ROTATION = {fromRotateDeg: 0, toRotateDeg: 0} as const;

// 최종 타임라인의 사진 장면은 회전 없이 밀고 당기기만 한다.
const motionParameters: Readonly<Record<PhotoMotion, NonNullable<RenderScene["motion"]>>> = {
  "pan-left": {
    ...NO_ROTATION,
    fromScale: 1.12,
    fromX: 0.04,
    fromY: 0,
    toScale: 1.12,
    toX: -0.04,
    toY: 0,
    type: "pan-left",
  },
  "pan-right": {
    ...NO_ROTATION,
    fromScale: 1.12,
    fromX: -0.04,
    fromY: 0,
    toScale: 1.12,
    toX: 0.04,
    toY: 0,
    type: "pan-right",
  },
  "slow-push-in": {
    ...NO_ROTATION,
    fromScale: 1,
    fromX: 0,
    fromY: 0,
    toScale: 1.08,
    toX: 0,
    toY: 0,
    type: "slow-push-in",
  },
  static: {
    ...NO_ROTATION,
    fromScale: 1,
    fromX: 0,
    fromY: 0,
    toScale: 1,
    toX: 0,
    toY: 0,
    type: "static",
  },
  "zoom-in": {
    ...NO_ROTATION,
    fromScale: 1,
    fromX: 0,
    fromY: 0,
    toScale: 1.15,
    toX: 0,
    toY: 0,
    type: "zoom-in",
  },
  "zoom-out": {
    ...NO_ROTATION,
    fromScale: 1.12,
    fromX: 0,
    fromY: 0,
    toScale: 1,
    toX: 0,
    toY: 0,
    type: "zoom-out",
  },
};

const selectedMediaHash = (index: MediaIndex, selectedIds: ReadonlySet<string>): string =>
  JSON.stringify(
    index.items
      .filter((item) => selectedIds.has(item.id))
      .map((item) => ({
        contentHash: item.contentHash,
        id: item.id,
        mediaType: item.mediaType,
        renderAssetKey: item.renderAssetKey,
      })),
  );

export const timelineStepInputHash = async (
  projectId: string,
  dependencies: Pick<TimelineDependencies, "storage">,
): Promise<string> => {
  const project = await loadProjectDocument(dependencies.storage, projectId);
  const index = await loadProjectMediaIndex(dependencies.storage, projectId);
  if (index === null) {
    throw new Error("미디어 목록을 찾을 수 없습니다.");
  }
  const selectedIds = new Set(
    project.chapters.flatMap((chapter) => chapter.scenes.map((scene) => scene.mediaId)),
  );
  return createHash("sha1")
    .update(JSON.stringify(project))
    .update(JSON.stringify(planSubtitles(project)))
    .update(selectedMediaHash(index, selectedIds))
    .update(`|${String(TIMELINE_CODE_VERSION)}|${String(PREPARE_CODE_VERSION)}`)
    .digest("hex");
};

/** 사진은 고화질 JPEG, 영상은 출력 해상도에 맞춰 다시 인코딩한 mp4 를 쓴다. */
const assetKeyFor = (item: MediaItem): string => {
  const key = item.renderAssetKey ?? (item.mediaType === "video" ? item.proxyKey : null);
  if (key === null) {
    throw new Error(`렌더 파일이 준비되지 않았습니다: ${item.filename}`);
  }
  return key;
};

export const buildRenderPlan = async (
  project: Project,
  index: MediaIndex,
  subtitles: SubtitleManifest,
  storage: StorageAdapter,
): Promise<TimelineBuildResult> => {
  const mediaById = new Map(index.items.map((item) => [item.id, item]));
  const warnings: string[] = [];

  const usableGeneratedChapters = new Set<string>();
  for (const chapter of project.chapters) {
    if (chapter.generatedVideo === null) {
      continue;
    }
    if (await storage.exists(chapter.generatedVideo.assetKey)) {
      usableGeneratedChapters.add(chapter.id);
    } else {
      warnings.push(`생성 클립을 찾지 못해 원본 장면을 사용했습니다: ${chapter.title}`);
    }
  }

  const plannedScenes: PlannedRenderScene[] = project.chapters.flatMap((chapter) => {
    const generated = usableGeneratedChapters.has(chapter.id) ? chapter.generatedVideo : null;
    const scenes = generated === null ? chapter.scenes : chapter.scenes.slice(0, 1);
    return scenes.map((scene) => {
      const item = mediaById.get(scene.mediaId);
      if (item === undefined) {
        throw new Error(`장면의 원본을 찾을 수 없습니다: ${scene.mediaId}`);
      }
      return {
        durationSec: generated === null ? scene.durationSec : generated.durationSec,
        id: scene.id,
        item,
        overrideAssetKey: generated?.assetKey ?? null,
        projectScene:
          generated === null
            ? scene
            : {...scene, durationSec: generated.durationSec, effect: null, trim: null},
        transitionIn: {
          durationSec: scene.transitionIn === "cut" ? 0 : TRANSITION_SEC,
          type: scene.transitionIn,
        },
      };
    });
  });

  const layout = layoutScenes(plannedScenes, project.output.fps);
  const dimensions = outputDimensions(project.output);

  const chapterIdBySceneId = new Map<string, string>();
  const chapterIds = new Set<string>();
  for (const chapter of project.chapters) {
    chapterIds.add(chapter.id);
    for (const scene of chapter.scenes) {
      chapterIdBySceneId.set(scene.id, chapter.id);
    }
  }

  const proposalByChapterId = new Map<string, (typeof subtitles.proposals)[number]>();
  for (const proposal of subtitles.proposals) {
    let chapterId: string | null = proposal.chapterId ?? null;
    if (chapterId === null && proposal.sceneId !== null) {
      chapterId = chapterIds.has(proposal.sceneId)
        ? proposal.sceneId
        : (chapterIdBySceneId.get(proposal.sceneId) ?? proposal.sceneId);
    }
    if (chapterId !== null && !proposalByChapterId.has(chapterId)) {
      proposalByChapterId.set(chapterId, proposal);
    }
  }

  const layoutScenesByChapter = new Map<string, typeof layout.scenes>();
  for (const scene of layout.scenes) {
    const chapterId = chapterIdBySceneId.get(scene.id);
    if (chapterId === undefined) {
      continue;
    }
    const bucket = layoutScenesByChapter.get(chapterId);
    if (bucket === undefined) {
      layoutScenesByChapter.set(chapterId, [scene]);
    } else {
      bucket.push(scene);
    }
  }

  interface CaptionInterval {
    readonly durationInFrames: number;
    readonly proposal: (typeof subtitles.proposals)[number];
    readonly startFrame: number;
  }
  const captionByChapter = new Map<string, CaptionInterval>();
  for (const [chapterId, proposal] of proposalByChapterId) {
    const scenesForChapter = layoutScenesByChapter.get(chapterId);
    if (scenesForChapter === undefined || scenesForChapter.length === 0) {
      continue;
    }
    const last = scenesForChapter.at(-1)!;
    const startFrame = scenesForChapter[0]!.startFrame + Math.round(0.4 * project.output.fps);
    const endFrame = last.startFrame + last.durationInFrames - Math.round(0.5 * project.output.fps);
    const durationInFrames = endFrame - startFrame;
    if (durationInFrames < Math.round(1.2 * project.output.fps)) {
      continue;
    }
    captionByChapter.set(chapterId, {durationInFrames, proposal, startFrame});
  }

  const assetKeys = [
    ...new Set(layout.scenes.map((scene) => scene.overrideAssetKey ?? assetKeyFor(scene.item))),
  ];
  const assetExists = await Promise.all(assetKeys.map((key) => storage.exists(key)));
  const missingIndex = assetExists.findIndex((exists) => !exists);
  if (missingIndex >= 0) {
    throw new Error(`렌더 파일을 찾을 수 없습니다: ${assetKeys[missingIndex]}`);
  }

  const scenes: RenderScene[] = layout.scenes.map((scene) => {
    const chapterId = chapterIdBySceneId.get(scene.id) ?? null;
    const interval = chapterId === null ? undefined : captionByChapter.get(chapterId);
    const generated = scene.overrideAssetKey !== null;
    const assetKey = scene.overrideAssetKey ?? assetKeyFor(scene.item);
    const captions = (() => {
      if (interval === undefined || chapterId === null) {
        return [];
      }
      const scenesForChapter = layoutScenesByChapter.get(chapterId) ?? [];
      const sceneStart = scene.startFrame;
      const sceneEnd = sceneStart + scene.durationInFrames;
      const captionStart = Math.max(interval.startFrame, sceneStart);
      const captionEnd = Math.min(interval.startFrame + interval.durationInFrames, sceneEnd);
      if (captionEnd - captionStart <= 0) {
        return [];
      }
      return [
        {
          durationInFrames: captionEnd - captionStart,
          fadeInFrames:
            scenesForChapter[0]?.id === scene.id ? framesFromSeconds(0.25, project.output.fps) : 0,
          fadeOutFrames:
            scenesForChapter.at(-1)?.id === scene.id
              ? framesFromSeconds(0.35, project.output.fps)
              : 0,
          kind: interval.proposal.kind,
          lines: interval.proposal.lines,
          startFrame: captionStart,
          style: interval.proposal.kind,
          text: interval.proposal.text,
        },
      ];
    })();

    return {
      assetKey,
      assetUrl: storage.publicUrl(assetKey),
      captions,
      durationInFrames: scene.durationInFrames,
      id: scene.id,
      look: scene.projectScene.look,
      mediaId: scene.item.id,
      montage: null,
      motion:
        !generated && scene.item.mediaType === "photo"
          ? motionParameters[scene.projectScene.motion]
          : null,
      sourceAudio: scene.projectScene.sourceAudio,
      startFrame: scene.startFrame,
      transitionIn: scene.transitionIn,
      trimStartFrame:
        !generated && scene.item.mediaType === "video" && scene.projectScene.trim !== null
          ? framesFromSeconds(scene.projectScene.trim.startSec, project.output.fps)
          : null,
      type: generated ? "video" : scene.item.mediaType,
      visibleFrames: scene.visibleFrames,
    };
  });

  const plan = renderPlanSchema.parse({
    audio: [],
    fps: project.output.fps,
    ...dimensions,
    scenes,
    schemaVersion: 2,
    totalFrames: layout.totalFrames,
  });
  return {plan, warnings};
};

export const createTimelineStep = (
  projectId: string,
  dependencies: TimelineDependencies,
  force: boolean,
): Step => ({
  codeVersion: TIMELINE_CODE_VERSION,
  invalidates: ["music", "render", "finalize", "verify"],
  name: "timeline",
  outputRef: () => renderPlanKey(projectId),
  run: async (context) => {
    const project = await loadProjectDocument(dependencies.storage, projectId);
    const index = await loadProjectMediaIndex(dependencies.storage, projectId);
    if (index === null) {
      throw new Error("미디어 목록을 찾을 수 없습니다.");
    }
    const selectedIds = [
      ...new Set(project.chapters.flatMap((chapter) => chapter.scenes.map((s) => s.mediaId))),
    ];
    context.report({message: "선택한 장면의 렌더 파일을 준비하는 중", progress: 0.08});
    const prepared = await prepareMedia(
      index,
      {
        force,
        mediaIds: selectedIds,
        renderTargetLongEdgePx: renderTargetLongEdgePx(project.output.resolution),
        signal: context.signal,
        stages: ["render"],
      },
      {
        database: dependencies.database,
        manifestKey: projectManifestKey(projectId),
        onProgress: ({completed, total}) => {
          context.report({
            message: `렌더 파일 ${String(completed)} / ${String(total)}`,
            progress: 0.08 + (total === 0 ? 0.57 : (completed / total) * 0.57),
          });
        },
        probe: dependencies.probe,
        storage: dependencies.storage,
        transcoder: dependencies.transcoder,
      },
    );
    context.report({message: "프레임 타임라인과 자막 위치를 계산하는 중", progress: 0.78});
    const result = await buildRenderPlan(
      project,
      prepared.index,
      planSubtitles(project),
      dependencies.storage,
    );
    await dependencies.storage.write(
      renderPlanKey(projectId),
      Buffer.from(JSON.stringify(result.plan, null, 2)),
    );
    await dependencies.storage.write(
      timelineWarningsKey(projectId),
      Buffer.from(
        JSON.stringify({createdAt: new Date().toISOString(), warnings: result.warnings}, null, 2),
      ),
    );
    updateTimelineConfirmation(dependencies.database, projectId, false);
    context.report({message: "타임라인 완성", progress: 1});
    return {
      planKey: renderPlanKey(projectId),
      totalFrames: result.plan.totalFrames,
      warnings: result.warnings,
    };
  },
});
