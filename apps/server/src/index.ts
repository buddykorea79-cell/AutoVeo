import {mkdir} from "node:fs/promises";
import path from "node:path";

import {buildApp} from "./app.js";
import {runtimeConfig} from "./config.js";
import {openDatabase} from "./db/database.js";
import {JobRunner} from "./jobs/job-runner.js";
import {FfmpegService} from "./services/ffmpeg.js";
import {FfprobeService} from "./services/ffprobe.js";
import {localFolderPicker} from "./services/folder-picker.js";
import {RemotionRenderService} from "./services/remotion.js";
import {OllamaService} from "./services/ollama.js";
import {ComfyService} from "./services/comfy.js";
import {getAdminSettings} from "./services/admin-settings.js";
import {LocalFsAdapter} from "./storage/local-fs-adapter.js";
import {FinalVideoFinalizer} from "./steps/finalize.js";

const start = async (): Promise<void> => {
  await Promise.all([
    mkdir(runtimeConfig.storageRoot, {recursive: true}),
    mkdir(runtimeConfig.outputRoot, {recursive: true}),
  ]);

  const databasePath = path.join(runtimeConfig.dataDir, "app.db");
  const databaseResult = openDatabase(databasePath);
  const storage = new LocalFsAdapter(runtimeConfig.storageRoot);
  const jobRunner = new JobRunner(databaseResult.database, storage);
  const transcoder =
    runtimeConfig.ffmpegPath === null ? undefined : new FfmpegService(runtimeConfig.ffmpegPath);
  const probe =
    runtimeConfig.ffprobePath === null ? undefined : new FfprobeService(runtimeConfig.ffprobePath);
  const renderer = new RemotionRenderService({
    browserExecutable: runtimeConfig.remotionBrowserExecutable,
    remotionRoot: path.join(runtimeConfig.workspaceRoot, "remotion"),
    storage,
  });
  const ollama =
    runtimeConfig.ollamaBaseUrl === null
      ? undefined
      : new OllamaService(runtimeConfig.ollamaBaseUrl);
  const getComfy = (): ComfyService | undefined => {
    const settings = getAdminSettings(databaseResult.database);
    const baseUrl = settings.comfyBaseUrl ?? runtimeConfig.comfyBaseUrl;
    const configuredWorkflowPath = settings.comfyWorkflowPath;
    const workflowPath =
      configuredWorkflowPath === null
        ? runtimeConfig.comfyWorkflowPath
        : path.isAbsolute(configuredWorkflowPath)
          ? path.normalize(configuredWorkflowPath)
          : path.resolve(runtimeConfig.workspaceRoot, configuredWorkflowPath);
    if (baseUrl === null || workflowPath === null || probe === undefined) {
      return undefined;
    }
    return new ComfyService({baseUrl, probe, storage, workflowPath});
  };
  const finalizer =
    runtimeConfig.ffmpegPath === null || probe === undefined || transcoder === undefined
      ? undefined
      : new FinalVideoFinalizer({
          ffmpegPath: runtimeConfig.ffmpegPath,
          outputRoot: runtimeConfig.outputRoot,
          probe,
          storage,
          transcoder,
        });
  const app = buildApp({
    database: databaseResult.database,
    // 폴더 선택 창은 앱이 설치된 위치에서 시작한다.
    defaultFolderPath: runtimeConfig.workspaceRoot,
    finalizer,
    folderPicker: localFolderPicker,
    getComfy,
    jobRunner,
    logger: true,
    musicCatalogPath: runtimeConfig.musicCatalogPath,
    musicRoot: runtimeConfig.musicRoot,
    ollama,
    probe,
    renderer,
    storage,
    transcoder,
  });

  app.addHook("onClose", async () => {
    databaseResult.database.close();
  });

  await app.listen({host: runtimeConfig.host, port: runtimeConfig.port});
};

start().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
