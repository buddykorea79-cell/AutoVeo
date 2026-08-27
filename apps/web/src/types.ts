import type {
  ClipAnalysis,
  ClipCaption,
  ClipKind,
  ClipStyle,
  LookPreset,
  MusicLibrary,
  MusicSelection,
  RenderPlan,
  TransitionType,
  VerifyReport,
} from "@travel-movie/schema";

export type StepName =
  | "scan"
  | "prepare"
  | "fingerprint"
  | "group-clips"
  | "detect-video-segments"
  | "extract-video-clips"
  | "analyze-clips"
  | "assemble"
  | "subtitle"
  | "timeline"
  | "music"
  | "render"
  | "finalize";

export type PipelineStep =
  | "import"
  | "group-clips"
  | "detect-video-segments"
  | "extract-video-clips"
  | "analyze-clips"
  | "timeline"
  | "music"
  | "render"
  | "finalize";

export interface StepStatus {
  readonly error: string | null;
  readonly message: string | null;
  readonly progress: number;
  readonly state: string;
}

export interface OutputSettings {
  readonly aspect: "16:9" | "9:16" | "1:1";
  readonly fps: 24 | 30 | 60;
  readonly resolution: "720p" | "1080p" | "4k";
  readonly style: "cinematic-travel" | "bright-vlog" | "family";
}

export interface WebProject extends OutputSettings {
  readonly activeJobId?: string | null;
  readonly createdAt: string;
  readonly folderPath: string;
  readonly id: string;
  readonly scanStatistics: Record<string, unknown> | null;
  readonly steps: Partial<Record<StepName, StepStatus>>;
  readonly title: string;
  readonly updatedAt: string;
}

export interface MediaSummary {
  readonly excluded: number;
  readonly photos: number;
  readonly total: number;
  readonly videos: number;
}

export interface MediaItemView {
  readonly capturedAtLocal: string;
  readonly durationSec: number | null;
  readonly filename: string;
  readonly id: string;
  readonly isClusterBest: boolean;
  readonly issues: readonly string[];
  readonly mediaType: "photo" | "video";
  readonly orientation: "landscape" | "portrait" | "square";
  readonly thumbUrl: string | null;
  readonly userDecision: "auto" | "include" | "exclude";
}

export interface MediaResponse {
  readonly items: readonly MediaItemView[];
  readonly summary: MediaSummary;
}

export interface GroupView {
  readonly clip: {
    readonly assetKey: string;
    readonly durationSec: number;
    readonly generator: "ffmpeg" | "comfy" | "remotion";
    readonly style: ClipStyle;
    readonly thumbKey: string | null;
  } | null;
  readonly endAtLocal: string;
  readonly id: string;
  readonly mediaIds: readonly string[];
  readonly photoNames: readonly string[];
  readonly photoThumbs: readonly (string | null)[];
  readonly source: "auto" | "user";
  readonly startAtLocal: string;
  readonly style: ClipStyle;
  readonly title: string;
}

export interface UngroupedPhoto {
  readonly capturedAtLocal: string;
  readonly filename: string;
  readonly id: string;
  readonly thumbUrl: string | null;
}

export interface GroupsResponse {
  readonly groups: readonly GroupView[];
  readonly mode: "auto" | "manual";
  readonly ungrouped: readonly UngroupedPhoto[];
}

export interface VideoSegmentView {
  readonly clip: {readonly assetKey: string; readonly durationSec: number} | null;
  readonly clipUrl: string | null;
  readonly durationSec: number;
  readonly endSec: number;
  readonly id: string;
  readonly reason: string;
  readonly score: number;
  readonly selected: boolean;
  readonly source: "auto" | "user";
  readonly sourceMediaId: string;
  readonly startSec: number;
  readonly thumbUrl: string | null;
}

export interface VideoSourceView {
  readonly capturedAtLocal: string;
  readonly durationSec: number;
  readonly filename: string;
  readonly mediaId: string;
  readonly previewUrl: string;
  readonly segments: readonly VideoSegmentView[];
}

export interface VideoSegmentsResponse {
  readonly videos: readonly VideoSourceView[];
}

export interface ClipView {
  readonly analysis: ClipAnalysis;
  readonly assetKey: string | null;
  readonly caption: ClipCaption | null;
  readonly durationSec: number;
  readonly endSec: number;
  readonly groupId: string | null;
  readonly id: string;
  readonly kind: ClipKind;
  readonly look: LookPreset;
  readonly mediaIds: readonly string[];
  readonly order: number;
  readonly previewUrl: string;
  readonly selected: boolean;
  readonly sourceMediaId: string | null;
  readonly startSec: number;
  readonly thumbUrl: string | null;
  readonly title: string;
  readonly transitionIn: TransitionType;
}

export interface ClipsResponse {
  readonly clips: readonly ClipView[];
  readonly totalDurationSec: number;
}

export interface ProgressEvent {
  readonly etaSec: number | null;
  readonly message: string | null;
  readonly progress: number;
  readonly state: string;
  readonly step: StepName;
}

export interface RenderResult {
  readonly finalReady: boolean;
  readonly finalUrl: string | null;
  readonly intermediateReady: boolean;
  readonly intermediateUrl: string | null;
  readonly report: VerifyReport | null;
}

export interface AdminSettings {
  readonly comfyBaseUrl: string | null;
  readonly comfyWorkflowPath: string | null;
  readonly defaultLook: "auto" | "vivid" | "film" | "mono";
  readonly defaultUtcOffsetMin: number;
  readonly defaultVideoShiftMin: number;
  readonly lastFolderPath: string | null;
  readonly ollamaModel: string | null;
}

export interface OllamaModel {
  readonly name: string;
  readonly parameterSize: string | null;
  readonly size: number;
  readonly vision: boolean;
}

export interface OllamaModelsResponse {
  readonly available: boolean;
  readonly baseUrl: string | null;
  readonly configured: boolean;
  readonly error: string | null;
  readonly models: readonly OllamaModel[];
}

export interface ComfyStatusResponse {
  readonly available: boolean;
  readonly baseUrl: string | null;
  readonly configured: boolean;
  readonly error: string | null;
  readonly workflowPath: string | null;
}

export type {ClipStyle, LookPreset, MusicLibrary, MusicSelection, RenderPlan, VerifyReport};
