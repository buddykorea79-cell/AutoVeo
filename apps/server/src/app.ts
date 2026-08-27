import type BetterSqlite3 from "better-sqlite3";
import Fastify from "fastify";

import type {JobRunner} from "./jobs/job-runner.js";
import {registerProjectRoutes} from "./routes/projects.js";
import type {StorageAdapter} from "./storage/storage-adapter.js";
import type {MediaTranscoder} from "./services/ffmpeg.js";
import type {MediaProbe} from "./services/ffprobe.js";
import {registerAssetRoutes} from "./routes/assets.js";
import {registerSystemRoutes} from "./routes/system.js";
import type {FolderPicker} from "./services/folder-picker.js";
import type {RemotionRenderService} from "./services/remotion.js";
import type {FinalVideoService} from "./steps/finalize.js";
import type {OllamaService} from "./services/ollama.js";
import type {ComfyService} from "./services/comfy.js";

export interface AppDependencies {
  readonly comfy?: ComfyService;
  readonly database: BetterSqlite3.Database;
  readonly defaultFolderPath?: string;
  readonly folderPicker?: FolderPicker;
  readonly finalizer?: FinalVideoService;
  readonly getComfy?: () => ComfyService | undefined;
  readonly jobRunner?: JobRunner;
  readonly logger?: boolean;
  readonly musicCatalogPath?: string;
  readonly musicRoot?: string;
  readonly ollama?: OllamaService;
  readonly probe?: MediaProbe;
  readonly renderer?: Pick<RemotionRenderService, "render">;
  readonly storage: StorageAdapter;
  readonly transcoder?: MediaTranscoder;
}

import {isStorageKeyEscapeError} from "./storage/storage-adapter.js";

export const buildApp = ({
  comfy,
  database,
  defaultFolderPath,
  folderPicker,
  finalizer,
  getComfy,
  jobRunner,
  logger = false,
  musicCatalogPath,
  musicRoot,
  ollama,
  probe,
  renderer,
  storage,
  transcoder,
}: AppDependencies) => {
  const app = Fastify({logger});
  const resolveComfy = getComfy ?? (() => comfy);

  app.setErrorHandler((error, _request, reply) => {
    if (isStorageKeyEscapeError(error)) {
      void reply.code(400).send({error: "invalid_storage_key"});
      return;
    }
    void reply.send(error);
  });

  app.get("/api/health", async () => {
    database.prepare("SELECT 1").get();
    const storageReady = await storage.exists("");

    return {
      checks: {
        database: "ok",
        storage: storageReady ? "ok" : "missing",
      },
      service: "autoveo-server",
      status: storageReady ? "ok" : "degraded",
    };
  });

  registerAssetRoutes(app, storage);
  registerSystemRoutes(app, {
    database,
    defaultFolderPath,
    folderPicker,
    getComfy: resolveComfy,
    ollama,
  });

  if (jobRunner !== undefined) {
    registerProjectRoutes(app, {
      database,
      finalizer,
      getComfy: resolveComfy,
      jobRunner,
      musicCatalogPath,
      musicRoot,
      ollama,
      probe,
      renderer,
      storage,
      transcoder,
    });
  }

  return app;
};
