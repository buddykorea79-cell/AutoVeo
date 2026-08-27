import {copyFile, mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type BetterSqlite3 from "better-sqlite3";
import type {FastifyInstance} from "fastify";

import {
  adminSettingsSchema,
  getAdminSettings,
  saveAdminSettings,
} from "../services/admin-settings.js";
import {FilePickerUnavailableError, type FilePicker} from "../services/file-picker.js";
import {FolderPickerUnavailableError, type FolderPicker} from "../services/folder-picker.js";
import {
  buildCatalogEntry,
  discoverMp3Files,
  refreshMusicCatalogFromFiles,
  readMusicCatalog,
  writeMusicCatalog,
} from "../services/music-library.js";
import type {OllamaService} from "../services/ollama.js";
import type {ComfyService} from "../services/comfy.js";

interface SystemRouteDependencies {
  readonly database: BetterSqlite3.Database;
  /** 폴더 선택 창이 처음 보여줄 폴더. 기본값은 앱이 실행 중인 위치다. */
  readonly defaultFolderPath?: string;
  readonly filePicker?: FilePicker;
  readonly folderPicker?: FolderPicker;
  readonly getComfy?: () => ComfyService | undefined;
  readonly musicCatalogPath?: string;
  readonly musicRoot?: string;
  readonly ollama?: OllamaService;
}

export const registerSystemRoutes = (
  app: FastifyInstance,
  {
    database,
    defaultFolderPath,
    filePicker,
    folderPicker,
    getComfy,
    musicCatalogPath,
    musicRoot,
    ollama,
  }: SystemRouteDependencies,
): void => {
  app.get("/api/admin/settings", async () => getAdminSettings(database));

  app.put<{Body: unknown}>("/api/admin/settings", async (request, reply) => {
    const parsed = adminSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({error: "invalid_admin_settings", issues: parsed.error.issues});
    }
    return saveAdminSettings(database, parsed.data);
  });

  app.get("/api/ai/ollama/models", async () => {
    if (ollama === undefined) {
      return {
        available: false,
        baseUrl: null,
        configured: false,
        error: "OLLAMA_BASE_URL이 설정되지 않았습니다.",
        models: [],
      };
    }
    return {configured: true, ...(await ollama.listModels())};
  });

  app.get("/api/ai/comfy/status", async () => {
    let comfy: ComfyService | undefined;
    try {
      comfy = getComfy?.();
    } catch (error) {
      return {
        available: false,
        baseUrl: null,
        configured: true,
        error: error instanceof Error ? error.message : String(error),
        workflowPath: null,
      };
    }
    if (comfy === undefined) {
      return {
        available: false,
        baseUrl: null,
        configured: false,
        error: "설정 화면에서 로컬 ComfyUI 주소와 API 워크플로 JSON 경로를 저장하세요.",
        workflowPath: null,
      };
    }
    return {configured: true, ...(await comfy.status())};
  });

  app.post("/api/system/select-folder", async (_request, reply) => {
    if (folderPicker === undefined) {
      return reply.code(503).send({
        error: "folder_picker_unavailable",
        message: "이 환경에서는 폴더 선택 창을 열 수 없습니다. 경로를 직접 입력하세요.",
      });
    }
    try {
      return {folderPath: await folderPicker.selectFolder(defaultFolderPath ?? process.cwd())};
    } catch (error) {
      if (error instanceof FolderPickerUnavailableError) {
        return reply.code(501).send({
          error: "folder_picker_unavailable",
          message:
            error.message.trim() || "폴더 선택 도구를 사용할 수 없습니다. 경로를 직접 입력하세요.",
        });
      }
      throw error;
    }
  });

  app.post("/api/system/select-music-file", async (_request, reply) => {
    if (filePicker === undefined) {
      return reply.code(503).send({
        error: "file_picker_unavailable",
        message: "이 환경에서는 파일 선택 창을 열 수 없습니다.",
      });
    }
    if (musicCatalogPath === undefined || musicRoot === undefined) {
      return reply.code(503).send({error: "music_services_unavailable"});
    }
    try {
      const selected = await filePicker.selectFile(musicRoot);
      if (selected === null) {
        return {filePath: null, registered: false};
      }
      // 선택한 파일이 musicRoot 바깥이면 복사해 넣는다
      const root = path.resolve(musicRoot);
      const resolved = path.resolve(selected);
      let relativePath: string;
      if (resolved.startsWith(`${root}${path.sep}`)) {
        relativePath = path.relative(root, resolved).split(path.sep).join(path.posix.sep);
      } else {
        const fileName = path.basename(resolved);
        const targetRel = `manual/${fileName}`;
        const targetAbs = path.join(root, targetRel);
        await mkdir(path.dirname(targetAbs), {recursive: true});
        await copyFile(resolved, targetAbs);
        relativePath = targetRel;
      }
      // 카탈로그에 없으면 추가
      const catalog = await readMusicCatalog(musicCatalogPath).catch(() => ({
        schemaVersion: 2 as const,
        tracks: [],
      }));
      if (!catalog.tracks.some((t) => t.path === relativePath)) {
        const entry = buildCatalogEntry(relativePath);
        // id 중복 방지
        const ids = new Set(catalog.tracks.map((t) => t.id));
        let id = entry.id;
        let n = 1;
        while (ids.has(id)) {
          n += 1;
          id = `${entry.id}-${n}`;
        }
        const next = {...catalog, tracks: [...catalog.tracks, {...entry, id}]};
        await writeMusicCatalog(musicCatalogPath, next);
      }
      return {filePath: relativePath, registered: true};
    } catch (error) {
      if (error instanceof FilePickerUnavailableError) {
        return reply.code(501).send({
          error: "file_picker_unavailable",
          message: error.message.trim() || "파일 선택 도구를 사용할 수 없습니다.",
        });
      }
      throw error;
    }
  });

  app.get("/api/music/catalog", async (_request, reply) => {
    if (musicCatalogPath === undefined || musicRoot === undefined) {
      return reply.code(503).send({error: "music_services_unavailable"});
    }
    try {
      const files = await discoverMp3Files(musicRoot);
      let catalog;
      try {
        catalog = await readMusicCatalog(musicCatalogPath);
      } catch {
        catalog = {schemaVersion: 2 as const, tracks: []};
      }
      return {catalog, files};
    } catch (error) {
      return reply.code(500).send({
        error: "catalog_read_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/music/catalog/refresh", async (_request, reply) => {
    if (musicCatalogPath === undefined || musicRoot === undefined) {
      return reply.code(503).send({error: "music_services_unavailable"});
    }
    try {
      const catalog = await refreshMusicCatalogFromFiles(musicCatalogPath, musicRoot);
      return {catalog, message: `${catalog.tracks.length}개 트랙을 등록했습니다.`};
    } catch (error) {
      return reply.code(500).send({
        error: "catalog_refresh_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post<{Body: {dataBase64?: string; filename?: string}}>(
    "/api/music/upload",
    {bodyLimit: 1024 * 1024 * 60},
    async (request, reply) => {
      if (musicCatalogPath === undefined || musicRoot === undefined) {
        return reply.code(503).send({error: "music_services_unavailable"});
      }
      const body = request.body as {dataBase64?: string; filename?: string};
      const filename = typeof body.filename === "string" ? body.filename.trim() : "";
      const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
      if (filename.length === 0 || dataBase64.length === 0) {
        return reply
          .code(400)
          .send({error: "invalid_upload", message: "filename과 dataBase64가 필요합니다."});
      }
      if (!filename.toLowerCase().endsWith(".mp3")) {
        return reply
          .code(400)
          .send({error: "invalid_upload", message: "MP3 파일만 업로드할 수 있습니다."});
      }
      const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/gu, "_");
      if (safeName.length === 0) {
        return reply.code(400).send({error: "invalid_filename"});
      }
      const relativePath = `manual/${safeName}`;
      const absolutePath = path.join(path.resolve(musicRoot), relativePath);
      try {
        const buffer = Buffer.from(dataBase64, "base64");
        if (buffer.length === 0 || buffer.length > 1024 * 1024 * 50) {
          return reply.code(400).send({
            error: "invalid_upload",
            message: "파일 크기가 비어있거나 너무 큽니다. (최대 50MB)",
          });
        }
        await mkdir(path.dirname(absolutePath), {recursive: true});
        await writeFile(absolutePath, buffer);
        // 카탈로그 등록
        let catalog;
        try {
          catalog = await readMusicCatalog(musicCatalogPath);
        } catch {
          catalog = {schemaVersion: 2 as const, tracks: []};
        }
        let existing = catalog.tracks.find((t) => t.path === relativePath);
        if (existing === undefined) {
          const entry = buildCatalogEntry(relativePath);
          const ids = new Set(catalog.tracks.map((t) => t.id));
          let id = entry.id;
          let n = 1;
          while (ids.has(id)) {
            n += 1;
            id = `${entry.id}-${n}`;
          }
          catalog = {schemaVersion: 2 as const, tracks: [...catalog.tracks, {...entry, id}]};
          await writeMusicCatalog(musicCatalogPath, catalog);
          existing = catalog.tracks.find((t) => t.path === relativePath)!;
        }
        return {path: relativePath, track: existing};
      } catch (error) {
        return reply.code(500).send({
          error: "upload_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
};
