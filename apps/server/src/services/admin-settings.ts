import type BetterSqlite3 from "better-sqlite3";
import {z} from "zod";

export const colorLookSchema = z.enum(["auto", "vivid", "film", "mono"]);
export type ColorLook = z.infer<typeof colorLookSchema>;

const localComfyUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        ["127.0.0.1", "::1", "localhost"].includes(url.hostname)
      );
    } catch {
      return false;
    }
  }, "ComfyUI URL은 이 컴퓨터의 localhost 주소만 사용할 수 있습니다.");

export const adminSettingsSchema = z
  .object({
    defaultLook: colorLookSchema,
    defaultUtcOffsetMin: z
      .number()
      .int()
      .min(-12 * 60)
      .max(14 * 60),
    defaultVideoShiftMin: z
      .number()
      .int()
      .min(-24 * 60)
      .max(24 * 60),
    comfyBaseUrl: localComfyUrlSchema.nullable().default(null),
    comfyWorkflowPath: z.string().trim().min(1).nullable().default(null),
    lastFolderPath: z.string().nullable(),
    ollamaModel: z.string().trim().min(1).nullable().default(null),
  })
  .strict();

export type AdminSettings = z.infer<typeof adminSettingsSchema>;

const SETTINGS_KEY = "admin";

export const defaultAdminSettings = (): AdminSettings => ({
  comfyBaseUrl: null,
  comfyWorkflowPath: null,
  defaultLook: "auto",
  defaultUtcOffsetMin: -new Date().getTimezoneOffset(),
  defaultVideoShiftMin: 0,
  lastFolderPath: null,
  ollamaModel: null,
});

export const getAdminSettings = (database: BetterSqlite3.Database): AdminSettings => {
  const row = database
    .prepare("SELECT value_json FROM app_settings WHERE key = ?")
    .get(SETTINGS_KEY) as {readonly value_json: string} | undefined;
  if (row === undefined) {
    return defaultAdminSettings();
  }
  return adminSettingsSchema.parse(JSON.parse(row.value_json));
};

export const saveAdminSettings = (
  database: BetterSqlite3.Database,
  settings: AdminSettings,
): AdminSettings => {
  const value = adminSettingsSchema.parse(settings);
  database
    .prepare(
      `INSERT INTO app_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(SETTINGS_KEY, JSON.stringify(value), new Date().toISOString());
  return value;
};

export const rememberLastFolder = (
  database: BetterSqlite3.Database,
  folderPath: string,
): AdminSettings =>
  saveAdminSettings(database, {...getAdminSettings(database), lastFolderPath: folderPath});
