import process from "node:process";

import type BetterSqlite3 from "better-sqlite3";
import type {FastifyInstance} from "fastify";

import {
  adminSettingsSchema,
  getAdminSettings,
  saveAdminSettings,
} from "../services/admin-settings.js";
import {FolderPickerUnavailableError, type FolderPicker} from "../services/folder-picker.js";
import type {OllamaService} from "../services/ollama.js";
import type {ComfyService} from "../services/comfy.js";

interface SystemRouteDependencies {
  readonly database: BetterSqlite3.Database;
  /** 폴더 선택 창이 처음 보여줄 폴더. 기본값은 앱이 실행 중인 위치다. */
  readonly defaultFolderPath?: string;
  readonly folderPicker?: FolderPicker;
  readonly getComfy?: () => ComfyService | undefined;
  readonly ollama?: OllamaService;
}

export const registerSystemRoutes = (
  app: FastifyInstance,
  {database, defaultFolderPath, folderPicker, getComfy, ollama}: SystemRouteDependencies,
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
};
