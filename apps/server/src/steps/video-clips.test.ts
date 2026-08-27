import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import {ffmpegPath, ffprobePath} from "ffmpeg-ffprobe-static";
import sharp from "sharp";
import {afterEach, describe, expect, it} from "vitest";

import {renderPlanSchema} from "@travel-movie/schema";

import {buildApp} from "../app.js";
import {runMigrations} from "../db/migrations.js";
import {JobRunner} from "../jobs/job-runner.js";
import {FfmpegService} from "../services/ffmpeg.js";
import {FfprobeService} from "../services/ffprobe.js";
import {LocalFsAdapter} from "../storage/local-fs-adapter.js";

interface PiexifApi {
  readonly ExifIFD: {readonly DateTimeOriginal: number};
  dump(value: Record<string, unknown>): string;
  insert(exif: string, jpeg: string): string;
}

const require = createRequire(import.meta.url);
const piexif = require("piexifjs/piexif.js") as PiexifApi;

const temporaryRoots: string[] = [];
const cleanupTasks: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    await cleanup();
  }
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, {force: true, maxRetries: 5, recursive: true, retryDelay: 100})),
  );
});

const writePhoto = async (filePath: string, dateTimeOriginal: string): Promise<void> => {
  const jpeg = await sharp({
    create: {background: "#3366cc", channels: 3, height: 480, width: 640},
  })
    .jpeg()
    .toBuffer();
  const exif = piexif.dump({
    Exif: {[piexif.ExifIFD.DateTimeOriginal]: dateTimeOriginal},
  } as unknown as Record<string, unknown>);
  const withExif = piexif.insert(exif, jpeg.toString("binary"));
  await writeFile(filePath, Buffer.from(withExif, "binary"));
};

const runStepAndWait = async (
  app: ReturnType<typeof buildApp>,
  projectId: string,
  step: string,
): Promise<void> => {
  const started = await app.inject({
    body: {force: false},
    method: "POST",
    url: `/api/projects/${projectId}/steps/${step}/run`,
  });
  if (started.statusCode !== 202) {
    throw new Error(`${step} 시작 실패 (${String(started.statusCode)}): ${started.body}`);
  }
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const project = await app.inject({method: "GET", url: `/api/projects/${projectId}`});
    const body = project.json<{
      activeJobId: string | null;
      steps: Record<string, {error: string | null; state: string}>;
    }>();
    if (body.activeJobId === null) {
      const failed = Object.entries(body.steps).find(([, value]) => value.state === "failed");
      if (failed !== undefined) {
        throw new Error(`${failed[0]} 단계가 실패했습니다: ${failed[1].error ?? ""}`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${step} 단계가 끝나지 않았습니다.`);
};

describe("사진 그룹과 영상 클립으로 타임라인 만들기", () => {
  const ffmpeg = ffmpegPath;
  const ffprobe = ffprobePath;

  it.runIf(ffmpeg !== null && ffprobe !== null)(
    "영상 구간을 잘라 만든 클립과 그룹 클립이 함께 렌더 계획에 들어간다",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "autoveo-e2e-"));
      temporaryRoots.push(root);
      const sourceRoot = path.join(root, "source");
      const storageRoot = path.join(root, "work");
      await mkdir(sourceRoot, {recursive: true});
      await mkdir(storageRoot, {recursive: true});

      const transcoder = new FfmpegService(ffmpeg!);
      const probe = new FfprobeService(ffprobe!);

      // 같은 시각대에 찍은 사진 3장 → 그룹 하나가 된다.
      await writePhoto(path.join(sourceRoot, "a.jpg"), "2026:05:01 10:00:00");
      await writePhoto(path.join(sourceRoot, "b.jpg"), "2026:05:01 10:01:00");
      await writePhoto(path.join(sourceRoot, "c.jpg"), "2026:05:01 10:02:00");
      // 20초짜리 촬영 영상 하나.
      await transcoder.run([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=30:duration=20",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        path.join(sourceRoot, "clip.mp4"),
      ]);

      const database = new Database(":memory:");
      runMigrations(database);
      const storage = new LocalFsAdapter(storageRoot);
      const app = buildApp({
        database,
        jobRunner: new JobRunner(database, storage),
        probe,
        storage,
        transcoder,
      });
      cleanupTasks.push(() => app.close());
      cleanupTasks.push(() => {
        database.close();
      });

      const created = await app.inject({
        body: {folderPath: sourceRoot, title: "테스트 여행"},
        method: "POST",
        url: "/api/projects",
      });
      expect(created.statusCode).toBe(201);
      const projectId = created.json<{id: string}>().id;

      // 720p 로 낮춰 테스트를 빠르게 끝낸다.
      const output = await app.inject({
        body: {aspect: "16:9", fps: 24, resolution: "720p", style: "cinematic-travel"},
        method: "PATCH",
        url: `/api/projects/${projectId}/output`,
      });
      expect(output.statusCode).toBe(200);

      await runStepAndWait(app, projectId, "import");

      // --- 사진 그룹: 자동으로 묶이고, 사람이 고칠 수 있다 ---
      const autoGroups = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/groups`,
      });
      expect(autoGroups.statusCode).toBe(200);
      const initial = autoGroups.json<{
        groups: {mediaIds: string[]}[];
        mode: string;
        ungrouped: unknown[];
      }>();
      expect(initial.mode).toBe("auto");
      expect(initial.groups).toHaveLength(1);
      expect(initial.groups[0]!.mediaIds).toHaveLength(3);

      // 사진 한 장을 떼어 두 그룹으로 나눈다.
      const [first, ...rest] = initial.groups[0]!.mediaIds;
      const saved = await app.inject({
        body: {groups: [{mediaIds: [first]}, {mediaIds: rest}]},
        method: "PUT",
        url: `/api/projects/${projectId}/groups`,
      });
      expect(saved.statusCode).toBe(200);
      const manual = saved.json<{groups: {source: string}[]; mode: string}>();
      expect(manual.mode).toBe("manual");
      expect(manual.groups).toHaveLength(2);
      expect(manual.groups.every((group) => group.source === "user")).toBe(true);

      await runStepAndWait(app, projectId, "group-clips");
      const grouped = await app.inject({method: "GET", url: `/api/projects/${projectId}/groups`});
      const groupClips = grouped.json<{groups: {clip: {durationSec: number} | null}[]}>();
      // 손으로 나눈 구성 그대로 클립이 만들어져야 한다.
      expect(groupClips.groups).toHaveLength(2);
      expect(groupClips.groups.every((group) => group.clip !== null)).toBe(true);

      // --- 영상: 구간을 찾고 고른 것만 클립으로 만든다 ---
      await runStepAndWait(app, projectId, "detect-video-segments");
      const detected = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/video-segments`,
      });
      expect(detected.statusCode).toBe(200);
      const videos = detected.json<{
        videos: {
          durationSec: number;
          segments: {id: string; selected: boolean; thumbUrl: string | null}[];
        }[];
      }>().videos;
      expect(videos).toHaveLength(1);
      expect(videos[0]!.segments.length).toBeGreaterThan(0);
      expect(videos[0]!.segments.some((segment) => segment.selected)).toBe(true);

      // 하나만 남기고 모두 뺀다.
      const keep = videos[0]!.segments.find((segment) => segment.selected)!;
      for (const segment of videos[0]!.segments) {
        if (segment.id === keep.id || !segment.selected) {
          continue;
        }
        const patched = await app.inject({
          body: {selected: false},
          method: "PATCH",
          url: `/api/projects/${projectId}/video-segments/${segment.id}`,
        });
        expect(patched.statusCode).toBe(200);
      }

      await runStepAndWait(app, projectId, "extract-video-clips");
      const extracted = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/video-segments`,
      });
      const extractedSegments = extracted.json<{
        videos: {segments: {clip: {durationSec: number} | null; id: string}[]}[];
      }>().videos[0]!.segments;
      const made = extractedSegments.find((segment) => segment.id === keep.id)!;
      expect(made.clip).not.toBeNull();
      expect(made.clip!.durationSec).toBeGreaterThan(1);

      // --- 클립 분석: 두 종류가 모두 들어온다 ---
      await runStepAndWait(app, projectId, "analyze-clips");
      const clips = await app.inject({method: "GET", url: `/api/projects/${projectId}/clips`});
      const clipList = clips.json<{
        clips: {assetKey: string | null; id: string; kind: string; look: string}[];
      }>().clips;
      expect(clipList.filter((clip) => clip.kind === "group")).toHaveLength(2);
      expect(clipList.filter((clip) => clip.kind === "source")).toHaveLength(1);
      // 영상에서 잘라 낸 클립도 자기 파일을 갖는다.
      expect(clipList.every((clip) => clip.assetKey !== null)).toBe(true);
      expect(clipList.every((clip) => clip.look === "none")).toBe(true);

      // --- 색감 필터를 모든 클립에 적용한다 ---
      const looked = await app.inject({
        body: {look: "mono"},
        method: "POST",
        url: `/api/projects/${projectId}/clips/look`,
      });
      expect(looked.statusCode).toBe(200);
      expect(looked.json<{clips: {look: string}[]}>().clips.every((c) => c.look === "mono")).toBe(
        true,
      );

      // --- 타임라인: 필터가 렌더 계획까지 전달된다 ---
      await runStepAndWait(app, projectId, "timeline");
      const planResponse = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/render-plan`,
      });
      expect(planResponse.statusCode).toBe(200);
      const plan = renderPlanSchema.parse(planResponse.json());
      expect(plan.scenes).toHaveLength(3);
      expect(plan.scenes.every((scene) => scene.look === "mono")).toBe(true);
      // 세 장면 모두 미리 만들어 둔 mp4 를 쓴다. 원본을 다시 자르지 않는다.
      expect(plan.scenes.every((scene) => scene.type === "video")).toBe(true);
      expect(plan.scenes.every((scene) => scene.trimStartFrame === null)).toBe(true);
      expect(plan.fps).toBe(24);
      expect(plan.totalFrames).toBeGreaterThan(0);
    },
    600_000,
  );
});
