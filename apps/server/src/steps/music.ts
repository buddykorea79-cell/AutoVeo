import {createHash} from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import {z} from "zod";

import {framesFromSeconds, layoutAudioSegments} from "@travel-movie/core";
import {
  audioTrackSchema,
  musicCandidateScoreSchema,
  musicLibrarySchema,
  musicSelectionSchema,
  projectSchema,
  renderPlanSchema,
  type AudioTrack,
  type Mood,
  type MusicCandidateScore,
  type MusicLibrary,
  type MusicSelection,
  type MusicTrack,
  type Project,
  type RenderPlan,
} from "@travel-movie/schema";

import type {Step} from "../jobs/job-runner.js";
import {
  musicLibraryInputHash,
  resolveMusicTrackPath,
  scanMusicLibrary,
} from "../services/music-library.js";
import type {MediaProbe} from "../services/ffprobe.js";
import {updateMusicConfirmation} from "../services/web-projects.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";
import {projectDocumentKey} from "./subtitle.js";
import {renderPlanKey} from "./timeline.js";

export const MUSIC_CODE_VERSION = 1;

export const musicStepParamsSchema = z
  .object({
    mode: z.enum(["auto", "manual", "none"]),
    trackIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type MusicStepParams = z.infer<typeof musicStepParamsSchema>;

export interface MusicSelectorConstraints {
  readonly excludeTrackIds: readonly string[];
  readonly minDurationSec: number;
}

export interface MusicTrackSelection {
  readonly candidates: readonly MusicCandidateScore[];
  readonly track: MusicTrack;
}

export interface MusicSelector {
  select(
    direction: {readonly energy: number; readonly mood: Mood},
    constraints: MusicSelectorConstraints,
  ): Promise<MusicTrackSelection | null>;
}

const directionTags: Readonly<Record<Mood, readonly string[]>> = {
  calm: ["calm", "acoustic", "ambient"],
  emotional: ["emotional", "cinematic"],
  night: ["ambient", "cinematic"],
  upbeat: ["upbeat", "acoustic"],
};

const rounded = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

export class RuleBasedMusicSelector implements MusicSelector {
  readonly #debug: (entry: unknown) => void;
  readonly #tracks: readonly MusicTrack[];

  constructor(
    tracks: readonly MusicTrack[],
    debug: (entry: unknown) => void = (entry) => console.debug("[music-selector]", entry),
  ) {
    this.#tracks = tracks;
    this.#debug = debug;
  }

  async select(
    direction: {readonly energy: number; readonly mood: Mood},
    constraints: MusicSelectorConstraints,
  ): Promise<MusicTrackSelection | null> {
    const excluded = new Set(constraints.excludeTrackIds);
    const expected = new Set(directionTags[direction.mood]);
    const candidates = this.#tracks
      .filter((track) => !excluded.has(track.id))
      .map((track) => {
        const moodMatch = track.mood.some((mood) => expected.has(mood)) ? 1 : 0;
        const energyMatch = Math.max(0, 1 - Math.abs(track.energy - direction.energy));
        const durationMatch = track.durationSec >= constraints.minDurationSec ? 1 : 0;
        const score = rounded(moodMatch * 0.5 + energyMatch * 0.3 + durationMatch * 0.2);
        return musicCandidateScoreSchema.parse({
          durationMatch,
          energyMatch: rounded(energyMatch),
          moodMatch,
          reason: `${direction.mood} 무드 ${moodMatch === 1 ? "일치" : "불일치"}, 에너지 ${Math.round(energyMatch * 100)}%, 길이 ${durationMatch === 1 ? "충족" : "부족"}`,
          score,
          trackId: track.id,
        });
      })
      .sort((left, right) => right.score - left.score || left.trackId.localeCompare(right.trackId));
    this.#debug({candidates, constraints, direction});
    const selected = candidates[0];
    if (selected === undefined) {
      return null;
    }
    return {
      candidates,
      track: this.#tracks.find((track) => track.id === selected.trackId)!,
    };
  }
}

interface MusicStepDependencies {
  readonly catalogPath: string;
  readonly database: BetterSqlite3.Database;
  readonly debug?: (entry: unknown) => void;
  readonly musicRoot: string;
  readonly probe: MediaProbe;
  readonly storage: StorageAdapter;
}

interface MusicStepOutput {
  readonly audio: readonly AudioTrack[];
  readonly library: MusicLibrary;
  readonly selection: MusicSelection;
}

interface ChapterBoundary {
  readonly chapterId: string;
  readonly direction: Project["chapters"][number]["musicDirection"];
  readonly startFrame: number;
}

export const musicLibraryKey = (projectId: string): string =>
  `manifests/${projectId}/music-library.json`;
export const musicSelectionKey = (projectId: string): string =>
  `manifests/${projectId}/music-selection.json`;

const trackCountLimit = (plan: RenderPlan): number => {
  if (plan.totalFrames < framesFromSeconds(180, plan.fps)) {
    return 1;
  }
  if (plan.totalFrames <= framesFromSeconds(360, plan.fps)) {
    return 2;
  }
  return Math.min(4, Math.ceil(plan.totalFrames / framesFromSeconds(180, plan.fps)));
};

const candidateChapterBoundaries = (project: Project, plan: RenderPlan): ChapterBoundary[] => {
  const startFrames = new Map(plan.scenes.map((scene) => [scene.id, scene.startFrame]));
  const candidates: ChapterBoundary[] = [];
  for (const [index, chapter] of project.chapters.entries()) {
    const firstScene = chapter.scenes[0];
    if (firstScene === undefined) {
      continue;
    }
    const startFrame = startFrames.get(firstScene.id);
    if (startFrame === undefined) {
      throw new Error(`타임라인에서 챕터 시작 장면을 찾을 수 없습니다: ${chapter.id}`);
    }
    const previous = project.chapters[index - 1];
    if (index === 0 || previous?.musicDirection.mood !== chapter.musicDirection.mood) {
      candidates.push({chapterId: chapter.id, direction: chapter.musicDirection, startFrame});
    }
  }
  if (candidates[0]?.startFrame !== 0) {
    throw new Error("음악의 첫 구간은 프레임 0에서 시작해야 합니다.");
  }
  return candidates;
};

const selectMusic = async (
  project: Project,
  plan: RenderPlan,
  library: MusicLibrary,
  params: MusicStepParams,
  musicRoot: string,
  debug?: (entry: unknown) => void,
): Promise<MusicStepOutput> => {
  const limit = trackCountLimit(plan);
  const totalDurationSec = plan.totalFrames / plan.fps;
  if (params.mode === "none") {
    return {
      audio: [],
      library,
      selection: musicSelectionSchema.parse({
        choices: [],
        mode: "none",
        schemaVersion: 2,
        totalDurationSec,
        trackCountLimit: limit,
        warnings: [],
      }),
    };
  }

  const allBoundaries = candidateChapterBoundaries(project, plan);
  const requestedCount =
    params.mode === "manual" ? Math.max(1, params.trackIds.length) : allBoundaries.length;
  const boundaries = allBoundaries.slice(0, Math.min(limit, requestedCount));
  const timings = layoutAudioSegments(
    boundaries.map((boundary) => ({startFrame: boundary.startFrame, value: boundary})),
    plan.totalFrames,
    plan.fps,
  );
  const warnings: MusicSelection["warnings"] = [];
  const choices: MusicSelection["choices"] = [];
  const audio: AudioTrack[] = [];
  const selectedTrackIds: string[] = [];
  const selector = new RuleBasedMusicSelector(library.tracks, debug);

  if (library.tracks.length === 0) {
    warnings.push({
      code: "no-tracks",
      message: "등록되어 있고 읽을 수 있는 MP3가 없습니다. 음악 폴더와 tracks.json을 확인하세요.",
    });
  }

  for (const [index, timing] of timings.entries()) {
    const minimumSec = timing.durationInFrames / plan.fps;
    let result: MusicTrackSelection | null;
    if (params.mode === "manual") {
      const requestedId = params.trackIds[Math.min(index, params.trackIds.length - 1)];
      const track = library.tracks.find((candidate) => candidate.id === requestedId);
      if (track === undefined) {
        throw new Error(`선택한 음악을 라이브러리에서 찾을 수 없습니다: ${requestedId ?? "없음"}`);
      }
      result = {candidates: [], track};
    } else {
      result = await selector.select(timing.value.direction, {
        excludeTrackIds: selectedTrackIds,
        minDurationSec: minimumSec,
      });
      if (result === null && selectedTrackIds.length > 0) {
        result = await selector.select(timing.value.direction, {
          excludeTrackIds: [],
          minDurationSec: minimumSec,
        });
        if (result !== null) {
          warnings.push({
            code: "reused-track",
            message: "추천 가능한 곡 수가 부족해 같은 음악을 다시 사용했습니다.",
          });
        }
      }
    }
    if (result === null) {
      continue;
    }

    const {track} = result;
    selectedTrackIds.push(track.id);
    if (track.durationSec < minimumSec) {
      warnings.push({
        code: "track-too-short",
        message: `${track.id}은 ${minimumSec.toFixed(1)}초 구간보다 짧습니다. 다음 단계에서 반복 재생이 필요합니다.`,
      });
    }
    choices.push({
      candidates: [...result.candidates],
      direction: timing.value.direction,
      reason:
        params.mode === "manual"
          ? "사용자가 직접 선택한 음악입니다."
          : `${timing.value.direction.mood} 무드와 에너지에 가장 가까운 후보입니다.`,
      startChapterId: timing.value.chapterId,
      trackId: track.id,
    });
    audio.push(
      audioTrackSchema.parse({
        duckRanges: [],
        durationInFrames: timing.durationInFrames,
        fadeInFrames: timing.fadeInFrames,
        fadeOutFrames: timing.fadeOutFrames,
        sourceOffsetSec: 0,
        sourcePath: resolveMusicTrackPath(musicRoot, track.path),
        startFrame: timing.startFrame,
        trackId: track.id,
        volumeDb: -6,
      }),
    );
  }

  return {
    audio,
    library,
    selection: musicSelectionSchema.parse({
      choices,
      mode: params.mode,
      schemaVersion: 2,
      totalDurationSec,
      trackCountLimit: limit,
      warnings,
    }),
  };
};

const parseStepOutput = (output: unknown): MusicStepOutput => {
  const raw = output as MusicStepOutput;
  return {
    audio: z.array(audioTrackSchema).parse(raw.audio),
    library: musicLibrarySchema.parse(raw.library),
    selection: musicSelectionSchema.parse(raw.selection),
  };
};

const persistMusicOutput = async (
  projectId: string,
  output: MusicStepOutput,
  dependencies: MusicStepDependencies,
): Promise<void> => {
  const planKey = renderPlanKey(projectId);
  const plan = renderPlanSchema.parse(
    JSON.parse((await dependencies.storage.read(planKey)).toString("utf8")),
  );
  const updatedPlan = renderPlanSchema.parse({...plan, audio: output.audio});
  await dependencies.storage.write(
    musicLibraryKey(projectId),
    Buffer.from(JSON.stringify(output.library, null, 2)),
  );
  await dependencies.storage.write(planKey, Buffer.from(JSON.stringify(updatedPlan, null, 2)));
  await dependencies.storage.write(
    musicSelectionKey(projectId),
    Buffer.from(JSON.stringify(output.selection, null, 2)),
  );
  updateMusicConfirmation(dependencies.database, projectId, false);
};

export const musicStepInputHash = async (
  projectId: string,
  dependencies: Pick<MusicStepDependencies, "catalogPath" | "musicRoot" | "storage">,
): Promise<string> => {
  const [projectBuffer, planBuffer, libraryHash] = await Promise.all([
    dependencies.storage.read(projectDocumentKey(projectId)),
    dependencies.storage.read(renderPlanKey(projectId)),
    musicLibraryInputHash(dependencies.catalogPath, dependencies.musicRoot),
  ]);
  const plan = renderPlanSchema.parse(JSON.parse(planBuffer.toString("utf8")));
  return createHash("sha1")
    .update(
      JSON.stringify({
        libraryHash,
        plan: {...plan, audio: []},
        project: projectSchema.parse(JSON.parse(projectBuffer.toString("utf8"))),
      }),
    )
    .digest("hex");
};

export const createMusicStep = (
  projectId: string,
  params: MusicStepParams,
  dependencies: MusicStepDependencies,
): Step => ({
  codeVersion: MUSIC_CODE_VERSION,
  invalidates: ["finalize", "verify"],
  name: "music",
  outputRef: () => musicSelectionKey(projectId),
  restoreCached: async (output) =>
    persistMusicOutput(projectId, parseStepOutput(output), dependencies),
  run: async (context) => {
    context.report({message: "로컬 MP3의 실제 길이를 확인하는 중", progress: 0.08});
    const library = await scanMusicLibrary(
      {
        catalogPath: dependencies.catalogPath,
        musicRoot: dependencies.musicRoot,
        probe: dependencies.probe,
      },
      (completed, total) =>
        context.report({
          message: `음악 확인 ${String(completed)} / ${String(total)}`,
          progress: total === 0 ? 0.55 : 0.08 + (completed / total) * 0.47,
        }),
    );
    context.report({message: "영상 길이와 무드에 맞는 음악을 고르는 중", progress: 0.68});
    const project = projectSchema.parse(
      JSON.parse((await dependencies.storage.read(projectDocumentKey(projectId))).toString("utf8")),
    );
    const plan = renderPlanSchema.parse(
      JSON.parse((await dependencies.storage.read(renderPlanKey(projectId))).toString("utf8")),
    );
    const output = await selectMusic(
      project,
      plan,
      library,
      musicStepParamsSchema.parse(params),
      dependencies.musicRoot,
      dependencies.debug,
    );
    await persistMusicOutput(projectId, output, dependencies);
    context.report({message: "배경음악 계획 완성", progress: 1});
    return output;
  },
});
