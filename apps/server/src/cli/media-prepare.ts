import path from "node:path";

import {mediaIndexSchema, projectSchema, type Project} from "@travel-movie/schema";

import {runtimeConfig} from "../config.js";
import {openDatabase} from "../db/database.js";
import {FfmpegService} from "../services/ffmpeg.js";
import {FfprobeService} from "../services/ffprobe.js";
import {DEFAULT_MEDIA_MANIFEST_KEY} from "../services/media-index.js";
import {LocalFsAdapter} from "../storage/local-fs-adapter.js";
import {prepareMedia, type PrepareStage} from "../steps/prepare.js";

interface CliOptions {
  readonly force: boolean;
  readonly mediaIds: readonly string[];
  readonly projectId: string;
  readonly stage?: PrepareStage;
}

const usage =
  "Usage: pnpm media:prepare -- --project <id> [--stage thumb|analysis|render] [--media-id <id>] [--force]";

const parseArgs = (args: readonly string[]): CliOptions => {
  let force = false;
  const mediaIds: string[] = [];
  let projectId: string | undefined;
  let stage: PrepareStage | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--project") {
      projectId = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--stage") {
      const value = args[index + 1];
      if (value !== "thumb" && value !== "analysis" && value !== "render") {
        throw new Error(`${usage}\nInvalid --stage value: ${String(value)}`);
      }
      stage = value;
      index += 1;
      continue;
    }
    if (argument === "--media-id") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${usage}\n--media-id requires a value`);
      }
      mediaIds.push(value);
      index += 1;
      continue;
    }
    throw new Error(`${usage}\nUnknown argument: ${String(argument)}`);
  }

  if (projectId === undefined || !/^[a-z0-9_-]+$/iu.test(projectId)) {
    throw new Error(`${usage}\n--project is required and may contain letters, digits, _ and -`);
  }
  return {force, mediaIds, projectId, ...(stage === undefined ? {} : {stage})};
};

const firstExistingKey = async (
  storage: LocalFsAdapter,
  candidates: readonly string[],
): Promise<string | null> => {
  for (const key of candidates) {
    if (await storage.exists(key)) {
      return key;
    }
  }
  return null;
};

const loadProject = async (storage: LocalFsAdapter, projectId: string): Promise<Project | null> => {
  const key = await firstExistingKey(storage, [
    `manifests/${projectId}/project.json`,
    "manifests/project.json",
  ]);
  if (key === null) {
    return null;
  }
  return projectSchema.parse(JSON.parse((await storage.read(key)).toString("utf8")));
};

const resolutionLongEdge = (project: Project | null): number => {
  if (project?.output.resolution === "720p") {
    return 1280;
  }
  if (project?.output.resolution === "4k") {
    return 3840;
  }
  return 1920;
};

const run = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const storage = new LocalFsAdapter(runtimeConfig.storageRoot);
  const manifestKey = await firstExistingKey(storage, [
    `manifests/${options.projectId}/media-index.json`,
    DEFAULT_MEDIA_MANIFEST_KEY,
  ]);
  if (manifestKey === null) {
    throw new Error(
      `No media index exists for project ${options.projectId}. Run the media scan step first.`,
    );
  }

  const index = mediaIndexSchema.parse(
    JSON.parse((await storage.read(manifestKey)).toString("utf8")),
  );
  const project = await loadProject(storage, options.projectId);
  let mediaIds: readonly string[] | undefined =
    options.mediaIds.length > 0 ? options.mediaIds : undefined;
  if (options.stage === "render" && mediaIds === undefined) {
    const projectMediaIds = project?.chapters.flatMap((chapter) =>
      chapter.scenes.map((scene) => scene.mediaId),
    );
    const includedMediaIds = index.items
      .filter((item) => item.userDecision === "include")
      .map((item) => item.id);
    mediaIds = [...new Set(projectMediaIds?.length ? projectMediaIds : includedMediaIds)];
    if (mediaIds.length === 0) {
      throw new Error(
        "Render preparation needs selected media. Create project.json, include media, or pass --media-id.",
      );
    }
  }

  if (runtimeConfig.ffprobePath === null || runtimeConfig.ffmpegPath === null) {
    throw new Error(
      "FFmpeg/ffprobe 바이너리를 찾을 수 없습니다. FFMPEG_PATH/FFPROBE_PATH를 설정하세요.",
    );
  }
  const databaseResult = openDatabase(path.join(runtimeConfig.dataDir, "app.db"));
  try {
    const result = await prepareMedia(
      index,
      {
        force: options.force,
        ...(mediaIds === undefined ? {} : {mediaIds}),
        renderTargetLongEdgePx: resolutionLongEdge(project),
        ...(options.stage === undefined ? {} : {stages: [options.stage]}),
      },
      {
        database: databaseResult.database,
        manifestKey,
        onLog: (message) => console.log(message),
        onProgress: ({completed, mediaId, stage, total}) =>
          console.log(`[${String(completed)}/${String(total)}] ${stage} ${mediaId}`),
        probe: new FfprobeService(runtimeConfig.ffprobePath),
        storage,
        transcoder: new FfmpegService(runtimeConfig.ffmpegPath),
      },
    );
    console.log(JSON.stringify(result.statistics, null, 2));
  } finally {
    databaseResult.database.close();
  }
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
