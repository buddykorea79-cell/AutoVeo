import type {
  AdminSettings,
  ClipsResponse,
  ClipStyle,
  ComfyStatusResponse,
  GroupsResponse,
  LookPreset,
  MediaResponse,
  MusicLibrary,
  MusicSelection,
  OllamaModelsResponse,
  OutputSettings,
  PipelineStep,
  RenderPlan,
  RenderResult,
  VideoSegmentsResponse,
  WebProject,
} from "./types";

interface ApiErrorBody {
  readonly error?: string;
  readonly message?: string;
}

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {...init, headers});
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new Error(body.message ?? body.error ?? `요청 실패 (${String(response.status)})`);
  }
  return response.json() as Promise<T>;
};

const projectPath = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}`;

export const api = {
  createProject: (input: {readonly folderPath: string; readonly title: string}) =>
    request<WebProject>("/api/projects", {body: JSON.stringify(input), method: "POST"}),

  getProject: (projectId: string) => request<WebProject>(projectPath(projectId)),

  saveOutput: (projectId: string, output: OutputSettings) =>
    request<WebProject>(`${projectPath(projectId)}/output`, {
      body: JSON.stringify(output),
      method: "PATCH",
    }),

  runStep: (projectId: string, step: PipelineStep, body: Record<string, unknown> = {}) =>
    request<{readonly jobId: string; readonly state: string; readonly step: string}>(
      `${projectPath(projectId)}/steps/${step}/run`,
      {body: JSON.stringify(body), method: "POST"},
    ),

  cancelJobs: (projectId: string) =>
    request<{readonly cancelled: number}>(`${projectPath(projectId)}/jobs/cancel`, {
      method: "POST",
    }),

  getMedia: (projectId: string) => request<MediaResponse>(`${projectPath(projectId)}/media`),

  setMediaDecision: (
    projectId: string,
    mediaId: string,
    userDecision: "auto" | "include" | "exclude",
  ) =>
    request<MediaResponse>(`/api/media/${encodeURIComponent(mediaId)}`, {
      body: JSON.stringify({projectId, userDecision}),
      method: "PATCH",
    }),

  getGroups: (projectId: string) => request<GroupsResponse>(`${projectPath(projectId)}/groups`),

  saveGroups: (
    projectId: string,
    groups: readonly {
      readonly mediaIds: readonly string[];
      readonly style?: ClipStyle;
      readonly title?: string;
    }[],
  ) =>
    request<GroupsResponse>(`${projectPath(projectId)}/groups`, {
      body: JSON.stringify({groups}),
      method: "PUT",
    }),

  setGroupStyle: (projectId: string, groupId: string, style: ClipStyle) =>
    request<GroupsResponse>(`${projectPath(projectId)}/groups/${encodeURIComponent(groupId)}`, {
      body: JSON.stringify({style}),
      method: "PATCH",
    }),

  resetGroups: (projectId: string) =>
    request<GroupsResponse>(`${projectPath(projectId)}/groups/auto`, {method: "POST"}),

  getVideoSegments: (projectId: string) =>
    request<VideoSegmentsResponse>(`${projectPath(projectId)}/video-segments`),

  patchVideoSegment: (
    projectId: string,
    segmentId: string,
    patch: {
      readonly endSec?: number;
      readonly selected?: boolean;
      readonly startSec?: number;
    },
  ) =>
    request<VideoSegmentsResponse>(
      `${projectPath(projectId)}/video-segments/${encodeURIComponent(segmentId)}`,
      {body: JSON.stringify(patch), method: "PATCH"},
    ),

  addVideoSegment: (
    projectId: string,
    input: {readonly endSec: number; readonly mediaId: string; readonly startSec: number},
  ) =>
    request<VideoSegmentsResponse>(`${projectPath(projectId)}/video-segments`, {
      body: JSON.stringify(input),
      method: "POST",
    }),

  deleteVideoSegment: (projectId: string, segmentId: string) =>
    request<VideoSegmentsResponse>(
      `${projectPath(projectId)}/video-segments/${encodeURIComponent(segmentId)}`,
      {method: "DELETE"},
    ),

  getClips: (projectId: string) => request<ClipsResponse>(`${projectPath(projectId)}/clips`),

  applyLookToAll: (projectId: string, look: LookPreset) =>
    request<ClipsResponse>(`${projectPath(projectId)}/clips/look`, {
      body: JSON.stringify({look}),
      method: "POST",
    }),

  patchClip: (
    projectId: string,
    clipId: string,
    patch: {
      readonly caption?: string | null;
      readonly endSec?: number;
      readonly look?: LookPreset;
      readonly selected?: boolean;
      readonly startSec?: number;
      readonly transitionIn?: "cut" | "fade" | "crossfade";
    },
  ) =>
    request<ClipsResponse>(`${projectPath(projectId)}/clips/${encodeURIComponent(clipId)}`, {
      body: JSON.stringify(patch),
      method: "PATCH",
    }),

  reorderClips: (projectId: string, order: readonly string[]) =>
    request<ClipsResponse>(`${projectPath(projectId)}/clips`, {
      body: JSON.stringify({order}),
      method: "PATCH",
    }),

  getRenderPlan: (projectId: string) =>
    request<RenderPlan>(`${projectPath(projectId)}/render-plan`),

  getTimelineWarnings: (projectId: string) =>
    request<{readonly warnings: readonly string[]}>(`${projectPath(projectId)}/timeline-warnings`),

  getMusicLibrary: (projectId: string) =>
    request<MusicLibrary>(`${projectPath(projectId)}/music-library`),

  getMusicSelection: (projectId: string) =>
    request<MusicSelection>(`${projectPath(projectId)}/music-selection`),

  musicPreviewUrl: (projectId: string, trackId: string) =>
    `${projectPath(projectId)}/music/tracks/${encodeURIComponent(trackId)}/audio`,

  getRenderResult: (projectId: string) =>
    request<RenderResult>(`${projectPath(projectId)}/render-result`),

  getAdminSettings: () => request<AdminSettings>("/api/admin/settings"),

  saveAdminSettings: (settings: AdminSettings) =>
    request<AdminSettings>("/api/admin/settings", {
      body: JSON.stringify(settings),
      method: "PUT",
    }),

  getOllamaModels: () => request<OllamaModelsResponse>("/api/ai/ollama/models"),

  getComfyStatus: () => request<ComfyStatusResponse>("/api/ai/comfy/status"),

  getFfmpegStatus: () =>
    request<{readonly available: boolean; readonly error: string | null}>(
      "/api/system/ffmpeg-status",
    ),

  selectFolder: () =>
    request<{readonly folderPath: string | null}>("/api/system/select-folder", {method: "POST"}),

  selectMusicFile: () =>
    request<{readonly filePath: string | null; readonly registered: boolean}>(
      "/api/system/select-music-file",
      {method: "POST"},
    ),

  getMusicCatalog: () =>
    request<{readonly catalog: unknown; readonly files: readonly string[]}>("/api/music/catalog"),

  refreshMusicCatalog: () =>
    request<{readonly catalog: unknown; readonly message: string}>("/api/music/catalog/refresh", {
      method: "POST",
    }),

  uploadMusic: (filename: string, dataBase64: string) =>
    request<{readonly path: string; readonly track: unknown}>("/api/music/upload", {
      body: JSON.stringify({dataBase64, filename}),
      method: "POST",
    }),
};
