import {z} from "zod";

import {schemaVersionSchema, timestampSchema} from "./common.js";

/** 영상 구간을 실제로 잘라 만든 mp4. 만들기 전에는 null 이다. */
export const extractedVideoClipSchema = z
  .object({
    assetKey: z.string().min(1),
    createdAt: timestampSchema,
    durationSec: z.number().finite().positive(),
    inputHash: z.string().min(1),
    thumbKey: z.string().min(1).nullable(),
  })
  .strict();

export type ExtractedVideoClip = z.infer<typeof extractedVideoClipSchema>;

/** 촬영 영상 한 편에서 잘라 쓸 후보 구간. 자동으로 만들고 사람이 고친다. */
export const videoClipSegmentSchema = z
  .object({
    clip: extractedVideoClipSchema.nullable().default(null),
    durationSec: z.number().finite().positive(),
    endSec: z.number().finite().nonnegative(),
    id: z.string().min(1),
    reason: z.string().max(200).default(""),
    score: z.number().finite().min(0).max(100).default(70),
    selected: z.boolean().default(false),
    source: z.enum(["auto", "user"]).default("auto"),
    sourceMediaId: z.string().min(1),
    startSec: z.number().finite().nonnegative(),
    thumbKey: z.string().min(1).nullable().default(null),
  })
  .strict()
  .superRefine((segment, context) => {
    if (segment.endSec <= segment.startSec) {
      context.addIssue({code: "custom", message: "endSec must exceed startSec", path: ["endSec"]});
    }
    if (Math.abs(segment.durationSec - (segment.endSec - segment.startSec)) > 0.05) {
      context.addIssue({
        code: "custom",
        message: "durationSec must match endSec - startSec",
        path: ["durationSec"],
      });
    }
  });

export type VideoClipSegment = z.infer<typeof videoClipSegmentSchema>;

export const videoClipSourceSchema = z
  .object({
    capturedAtLocal: z.string().min(1),
    durationSec: z.number().finite().positive(),
    filename: z.string().min(1),
    mediaId: z.string().min(1),
    segments: z.array(videoClipSegmentSchema),
  })
  .strict();

export type VideoClipSource = z.infer<typeof videoClipSourceSchema>;

export const videoClipManifestSchema = z
  .object({
    createdAt: timestampSchema,
    projectId: z.string().min(1),
    schemaVersion: schemaVersionSchema,
    videos: z.array(videoClipSourceSchema),
  })
  .strict();

export type VideoClipManifest = z.infer<typeof videoClipManifestSchema>;

/** 자동 탐지가 지켜야 하는 구간 길이. 사람이 고칠 때도 같은 범위를 강제한다. */
export const VIDEO_SEGMENT_LIMITS = {
  autoPerVideo: 3,
  maxPerVideo: 12,
  maxSec: 20,
  minSec: 2,
} as const;
