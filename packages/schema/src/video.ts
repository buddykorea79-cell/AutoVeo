import {z} from "zod";

import {schemaVersionSchema, timestampSchema} from "./common.js";

export const VIDEO_ANALYSIS_VERSION = "video-analysis-v1" as const;

export const videoSourceMetadataSchema = z
  .object({
    audioCodec: z.string().nullable(),
    bitrate: z.number().nonnegative().nullable(),
    codec: z.string().min(1),
    creationTime: z.string().nullable(),
    duration: z.number().finite().positive(),
    fileSize: z.number().int().nonnegative(),
    filename: z.string().min(1),
    fps: z.number().finite().positive(),
    hasAudio: z.boolean(),
    height: z.number().int().positive(),
    path: z.string().min(1),
    rotation: z.number().finite().default(0),
    width: z.number().int().positive(),
  })
  .strict();

export type VideoSourceMetadata = z.infer<typeof videoSourceMetadataSchema>;

export const videoSegmentScoresSchema = z
  .object({
    aesthetic: z.number().finite().min(0).max(1),
    motion: z.number().finite().min(0).max(1),
    novelty: z.number().finite().min(0).max(1),
    semantic: z.number().finite().min(0).max(1),
    sharpness: z.number().finite().min(0).max(1),
    stability: z.number().finite().min(0).max(1),
  })
  .strict();

export type VideoSegmentScores = z.infer<typeof videoSegmentScoresSchema>;

export const VIDEO_CATEGORY_VALUES = [
  "landscape_reveal",
  "action",
  "orbit",
  "fly_through",
  "static_beauty",
  "subject_focus",
  "transition",
  "highlight",
  "general",
] as const;

export const videoSegmentSchema = z
  .object({
    category: z.enum(VIDEO_CATEGORY_VALUES),
    description: z.string().max(500),
    duration: z.number().finite().positive(),
    end: z.number().finite().nonnegative(),
    id: z.string().min(1),
    score: z.number().finite().min(0).max(100),
    scores: videoSegmentScoresSchema,
    sourceVideo: z.string().min(1),
    sourceVideoId: z.string().min(1),
    start: z.number().finite().nonnegative(),
    tags: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((segment, ctx) => {
    if (segment.end <= segment.start) {
      ctx.addIssue({code: "custom", message: "end must be greater than start", path: ["end"]});
    }
    if (Math.abs(segment.duration - (segment.end - segment.start)) > 0.05) {
      ctx.addIssue({
        code: "custom",
        message: "duration must match end - start",
        path: ["duration"],
      });
    }
  });

export type VideoSegment = z.infer<typeof videoSegmentSchema>;

export const videoAnalysisResultSchema = z
  .object({
    analysisVersion: z.string().min(1),
    cached: z.boolean().default(false),
    createdAt: timestampSchema,
    metadata: videoSourceMetadataSchema,
    proxyKey: z.string().nullable(),
    schemaVersion: schemaVersionSchema,
    segments: z.array(videoSegmentSchema),
    sourceId: z.string().min(1),
    sourcePath: z.string().min(1),
    thumbKey: z.string().nullable(),
  })
  .strict();

export type VideoAnalysisResult = z.infer<typeof videoAnalysisResultSchema>;

export const videoAnalysisManifestSchema = z
  .object({
    analyses: z.array(videoAnalysisResultSchema),
    createdAt: timestampSchema,
    projectId: z.string().min(1),
    schemaVersion: schemaVersionSchema,
    sourceRoot: z.string().min(1),
  })
  .strict();

export type VideoAnalysisManifest = z.infer<typeof videoAnalysisManifestSchema>;

export const clipExportRequestSchema = z
  .object({
    end: z.number().finite().nonnegative(),
    outputSubdir: z.string().min(1).max(80).optional(),
    segmentId: z.string().min(1).optional(),
    sourceId: z.string().min(1),
    start: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.end <= value.start) {
      ctx.addIssue({code: "custom", message: "end must be greater than start", path: ["end"]});
    }
  });

export type ClipExportRequest = z.infer<typeof clipExportRequestSchema>;

export const VIDEO_WEIGHTS = {
  aesthetic: 0.15,
  motion: 0.1,
  novelty: 0.1,
  semantic: 0.35,
  sharpness: 0.15,
  stability: 0.15,
} as const;

export const VIDEO_CLIP_LIMITS = {
  autoMaxSec: 30,
  autoMinSec: 5,
  autoPreferredMaxSec: 20,
  autoPreferredMinSec: 8,
  mergeGapSec: 2,
  paddingPostSec: 1.5,
  paddingPreSec: 1.5,
} as const;
