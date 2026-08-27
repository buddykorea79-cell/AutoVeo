import {createHash} from "node:crypto";

import {
  projectSchema,
  type MediaIndex,
  type MediaItem,
  type Mood,
  type PipelineClip,
  type Project,
  type ProjectChapter,
  type ProjectScene,
} from "@travel-movie/schema";

import type {Step, StepContext} from "../jobs/job-runner.js";
import type {OutputAspect, OutputResolution} from "../services/output-format.js";
import {loadProjectMediaIndex} from "../services/web-projects.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";
import {loadClipManifest} from "./analyze-clips.js";
import {projectDocumentKey} from "./subtitle.js";

/** v2: 촬영 영상도 잘라 낸 클립 파일을 쓰므로 assetKey 가 있으면 생성 클립으로 다룬다. */
export const ASSEMBLE_CODE_VERSION = 2;

export interface AssembleParams {
  readonly aspect: OutputAspect;
  readonly fps: 24 | 30 | 60;
  readonly resolution: OutputResolution;
  readonly style: "cinematic-travel" | "bright-vlog" | "family";
}

export interface AssembleDependencies {
  readonly storage: StorageAdapter;
}

const moodForHour = (hour: number): Mood =>
  hour < 6 || hour >= 19 ? "night" : hour >= 10 && hour <= 17 ? "upbeat" : "calm";

const energyForMood = (mood: Mood): number =>
  mood === "upbeat" ? 0.7 : mood === "night" ? 0.3 : mood === "emotional" ? 0.45 : 0.35;

const selectedClips = (clips: readonly PipelineClip[]): PipelineClip[] =>
  clips.filter((clip) => clip.selected).toSorted((left, right) => left.order - right.order);

export const assembleInputHash = async (
  projectId: string,
  dependencies: AssembleDependencies,
  params: AssembleParams,
): Promise<string> => {
  const manifest = await loadClipManifest(dependencies.storage, projectId);
  if (manifest === null) {
    throw new Error("먼저 클립을 분석하세요.");
  }
  return createHash("sha1")
    .update(
      JSON.stringify({
        clips: selectedClips(manifest.clips),
        params,
        version: ASSEMBLE_CODE_VERSION,
      }),
    )
    .digest("hex");
};

const sceneForClip = (
  clip: PipelineClip,
  item: MediaItem,
  isFirst: boolean,
  isLast: boolean,
): ProjectScene => ({
  caption: null,
  durationSec: clip.durationSec,
  effect: null,
  id: `s_${clip.id}`,
  importance: Math.min(1, clip.analysis.score / 100),
  locked: false,
  look: clip.look,
  mediaId: item.id,
  motion: "static",
  remotionPrompt: null,
  role: isFirst
    ? "opening"
    : isLast
      ? "closing"
      : clip.analysis.score >= 80
        ? "highlight"
        : "filler",
  sourceAudio: "mute",
  transitionIn: isFirst ? "fade" : clip.transitionIn,
  // 클립 파일이 이미 잘려 있으면 다시 자르지 않는다.
  trim:
    clip.kind === "source" && clip.assetKey === null
      ? {endSec: clip.endSec, startSec: clip.startSec}
      : null,
});

export const buildProjectFromClips = (
  projectId: string,
  title: string,
  index: MediaIndex,
  clips: readonly PipelineClip[],
  params: AssembleParams,
): Project => {
  const chosen = selectedClips(clips);
  if (chosen.length === 0) {
    throw new Error("영상에 넣을 클립을 최소 한 개 선택하세요.");
  }
  const byId = new Map(index.items.map((item) => [item.id, item]));
  const chapters: ProjectChapter[] = chosen.map((clip, position) => {
    const primaryId = clip.kind === "source" ? clip.sourceMediaId! : clip.mediaIds[0]!;
    const item = byId.get(primaryId);
    if (item === undefined) {
      throw new Error(`클립의 원본을 찾을 수 없습니다: ${clip.title}`);
    }
    const hour = Number(item.capturedAtLocal.slice(11, 13));
    const mood = moodForHour(Number.isFinite(hour) ? hour : 12);
    const scene = sceneForClip(clip, item, position === 0, position === chosen.length - 1);
    return {
      caption:
        clip.caption === null || clip.caption.text.trim().length === 0
          ? null
          : {kind: "scene-caption", source: clip.caption.source, text: clip.caption.text},
      dateLocal: item.capturedAtLocal.slice(0, 10),
      // 그룹 클립과 영상에서 잘라 낸 클립 모두 이미 만들어진 mp4 를 그대로 쓴다.
      generatedVideo:
        clip.assetKey !== null
          ? {
              assetKey: clip.assetKey,
              createdAt: new Date(0).toISOString(),
              durationSec: clip.durationSec,
              inputHash: clip.id,
              prompt: clip.title,
              sourceMediaIds: clip.mediaIds.slice(0, 5),
            }
          : null,
      id: `c_${clip.id}`,
      mood,
      musicDirection: {energy: energyForMood(mood), mood},
      place: item.place?.city ?? null,
      scenes: [scene],
      title: clip.title,
    };
  });

  const totalSec = chapters.reduce(
    (sum, chapter) => sum + chapter.scenes.reduce((inner, scene) => inner + scene.durationSec, 0),
    0,
  );

  return projectSchema.parse({
    budget: {
      photoBaseSec: 3.6,
      photoMaxSec: 6,
      targetDurationSec: Math.max(1, Math.round(totalSec * 100) / 100),
      targetSceneCount: chapters.length,
      videoMaxSec: 30,
    },
    chapters,
    id: projectId,
    output: {aspect: params.aspect, fps: params.fps, resolution: params.resolution},
    schemaVersion: 2,
    style: params.style,
    title,
  });
};

export const createAssembleStep = (
  projectId: string,
  title: string,
  params: AssembleParams,
  dependencies: AssembleDependencies,
): Step => ({
  codeVersion: ASSEMBLE_CODE_VERSION,
  invalidates: ["timeline", "music", "render", "finalize"],
  name: "assemble",
  outputRef: () => projectDocumentKey(projectId),
  run: async (context: StepContext) => {
    context.report({message: "선택한 클립으로 영상 구성을 만드는 중", progress: 0.2});
    const index = await loadProjectMediaIndex(dependencies.storage, projectId);
    if (index === null) {
      throw new Error("먼저 원본을 불러오세요.");
    }
    const manifest = await loadClipManifest(dependencies.storage, projectId);
    if (manifest === null) {
      throw new Error("먼저 클립을 분석하세요.");
    }
    const project = buildProjectFromClips(projectId, title, index, manifest.clips, params);
    await dependencies.storage.write(
      projectDocumentKey(projectId),
      Buffer.from(JSON.stringify(project, null, 2)),
    );
    context.report({message: "영상 구성 완료", progress: 1});
    return {chapters: project.chapters.length, durationSec: project.budget.targetDurationSec};
  },
});
