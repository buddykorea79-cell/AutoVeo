import {existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {config as loadEnv} from "dotenv";
import {
  ffmpegPath as bundledFfmpegPath,
  ffprobePath as bundledFfprobePath,
} from "ffmpeg-ffprobe-static";

export const workspaceRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

loadEnv({path: path.join(workspaceRoot, ".env"), quiet: true});

const resolveWorkspacePath = (value: string): string => {
  const resolved = path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(workspaceRoot, value);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`Path must not be filesystem root: ${value}`);
  }
  if (!path.isAbsolute(value)) {
    const relative = path.relative(workspaceRoot, resolved);
    if (relative.startsWith(`..${path.sep}`) || relative === "..") {
      throw new Error(`Path escapes workspace root: ${value}`);
    }
  }
  if (value.includes("\0")) {
    throw new Error(`Path must not contain null bytes: ${value}`);
  }
  return resolved;
};

const readPort = (value: string | undefined): number => {
  const port = Number(value ?? "5178");

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received: ${value}`);
  }

  return port;
};

const detectBrowserExecutable = (): string | null => {
  if (process.env.REMOTION_BROWSER_EXECUTABLE !== undefined) {
    return resolveWorkspacePath(process.env.REMOTION_BROWSER_EXECUTABLE);
  }
  const candidates =
    process.platform === "win32"
      ? [
          process.env.ProgramFiles === undefined
            ? null
            : path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
          process.env["ProgramFiles(x86)"] === undefined
            ? null
            : path.join(
                process.env["ProgramFiles(x86)"],
                "Google",
                "Chrome",
                "Application",
                "chrome.exe",
              ),
          process.env.LOCALAPPDATA === undefined
            ? null
            : path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return (
    candidates.find(
      (candidate): candidate is string => candidate !== null && existsSync(candidate),
    ) ?? null
  );
};

const resolveBinaryPath = (
  envValue: string | undefined,
  bundledPath: string | null | undefined,
  fallback: string | null = null,
): string | null => {
  if (envValue !== undefined) {
    const resolved = resolveWorkspacePath(envValue);
    return existsSync(resolved) ? resolved : envValue;
  }
  if (bundledPath !== null && bundledPath !== undefined && existsSync(bundledPath)) {
    return bundledPath;
  }
  return fallback;
};

export const runtimeConfig = {
  comfyBaseUrl: process.env.COMFY_BASE_URL ?? null,
  comfyWorkflowPath:
    process.env.COMFY_WORKFLOW_PATH === undefined
      ? null
      : resolveWorkspacePath(process.env.COMFY_WORKFLOW_PATH),
  dataDir: resolveWorkspacePath(process.env.APP_DATA_DIR ?? "data"),
  ffmpegPath: resolveBinaryPath(process.env.FFMPEG_PATH, bundledFfmpegPath, null),
  ffprobePath: resolveBinaryPath(process.env.FFPROBE_PATH, bundledFfprobePath, null),
  host: process.env.HOST ?? "127.0.0.1",
  musicCatalogPath: resolveWorkspacePath(
    process.env.APP_MUSIC_CATALOG ?? path.join("config", "music", "tracks.json"),
  ),
  musicRoot: resolveWorkspacePath(process.env.APP_MUSIC_ROOT ?? "music"),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? null,
  outputRoot: resolveWorkspacePath(process.env.APP_OUTPUT_ROOT ?? "output"),
  port: readPort(process.env.PORT),
  remotionBrowserExecutable: detectBrowserExecutable(),
  storageRoot: resolveWorkspacePath(process.env.APP_STORAGE_ROOT ?? "work"),
  workspaceRoot,
} as const;
