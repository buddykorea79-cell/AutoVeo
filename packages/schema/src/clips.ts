import {z} from "zod";

import {
  captionSourceSchema,
  localDateTimeSchema,
  schemaVersionSchema,
  timestampSchema,
  transitionTypeSchema,
} from "./common.js";
import {lookPresetSchema} from "./look.js";
import {VIDEO_CATEGORY_VALUES} from "./video.js";

/**
 * 사진 그룹으로 만들 클립의 움직임 세기.
 * 같은 사진이라도 이 값에 따라 전혀 다른 느낌의 클립이 나온다.
 */
export const clipStyleSchema = z.enum(["simple", "standard", "dynamic"]);
export type ClipStyle = z.infer<typeof clipStyleSchema>;
export const CLIP_STYLE_VALUES = clipStyleSchema.options;

export const CLIP_STYLE_LABELS: Readonly<Record<ClipStyle, string>> = {
  dynamic: "역동적으로",
  simple: "차분하게",
  standard: "기본",
};

export const CLIP_STYLE_DESCRIPTIONS: Readonly<Record<ClipStyle, string>> = {
  dynamic: "빠르게 밀고 당기며 살짝 기울입니다. 짧고 강한 장면에 어울립니다.",
  simple: "거의 움직이지 않고 길게 보여 줍니다. 풍경과 인물 사진에 어울립니다.",
  standard: "사진마다 방향을 바꿔 천천히 움직입니다.",
};

/** 사진 한 장의 노출 시간과 겹치는 시간. 프레임 계산은 core 에서만 한다. */
export const CLIP_STYLE_TIMING: Readonly<
  Record<ClipStyle, {readonly crossfadeSec: number; readonly perPhotoSec: number}>
> = {
  dynamic: {crossfadeSec: 0.3, perPhotoSec: 1.9},
  simple: {crossfadeSec: 0.9, perPhotoSec: 3.4},
  standard: {crossfadeSec: 0.5, perPhotoSec: 2.6},
};

/** 그룹으로 실제 만들어 낸 mp4 클립. 생성 전에는 null 이다. */
export const generatedGroupClipSchema = z
  .object({
    assetKey: z.string().min(1),
    createdAt: timestampSchema,
    durationSec: z.number().finite().positive(),
    generator: z.enum(["ffmpeg", "comfy", "remotion"]),
    inputHash: z.string().min(1),
    style: clipStyleSchema.default("standard"),
    thumbKey: z.string().min(1).nullable(),
  })
  .strict();

export type GeneratedGroupClip = z.infer<typeof generatedGroupClipSchema>;

/** 사진을 시간순으로 묶은 작은 그룹. 그룹 하나가 영상 클립 하나가 된다. */
export const photoGroupSchema = z
  .object({
    clip: generatedGroupClipSchema.nullable().default(null),
    endAtLocal: localDateTimeSchema,
    id: z.string().min(1),
    mediaIds: z.array(z.string().min(1)).min(1).max(6),
    /** "user" 는 사람이 손으로 고친 그룹이다. 자동 재계산으로 덮어쓰지 않는다. */
    source: z.enum(["auto", "user"]).default("auto"),
    startAtLocal: localDateTimeSchema,
    style: clipStyleSchema.default("standard"),
    title: z.string().min(1),
  })
  .strict();

export type PhotoGroup = z.infer<typeof photoGroupSchema>;

export const groupManifestSchema = z
  .object({
    createdAt: timestampSchema,
    groups: z.array(photoGroupSchema),
    /** "manual" 이면 자동 묶기를 다시 하지 않고 저장된 그룹을 그대로 쓴다. */
    mode: z.enum(["auto", "manual"]).default("auto"),
    projectId: z.string().min(1),
    schemaVersion: schemaVersionSchema,
  })
  .strict();

export type GroupManifest = z.infer<typeof groupManifestSchema>;

export const clipCaptionSchema = z
  .object({
    source: captionSourceSchema,
    text: z.string().max(200),
  })
  .strict();

export type ClipCaption = z.infer<typeof clipCaptionSchema>;

export const clipKindSchema = z.enum(["group", "source"]);
export type ClipKind = z.infer<typeof clipKindSchema>;

export const clipAnalysisSchema = z
  .object({
    aiUsed: z.boolean().default(false),
    category: z.enum(VIDEO_CATEGORY_VALUES).default("general"),
    description: z.string().max(300).default(""),
    score: z.number().finite().min(0).max(100).default(70),
    tags: z.array(z.string().min(1)).max(8).default([]),
  })
  .strict();

export type ClipAnalysis = z.infer<typeof clipAnalysisSchema>;

/**
 * 파이프라인의 중심 단위.
 * - kind "group": 사진 그룹으로 만들어 낸 생성 클립 (assetKey 가 실제 mp4)
 * - kind "source": 업로드한 원본 영상에서 AI 가 추천한 구간
 */
export const pipelineClipSchema = z
  .object({
    analysis: clipAnalysisSchema,
    assetKey: z.string().min(1).nullable(),
    caption: clipCaptionSchema.nullable().default(null),
    durationSec: z.number().finite().positive(),
    endSec: z.number().finite().nonnegative(),
    groupId: z.string().min(1).nullable(),
    id: z.string().min(1),
    kind: clipKindSchema,
    /** 이 클립에 입힐 색감 필터. 렌더할 때 적용한다. */
    look: lookPresetSchema.default("none"),
    mediaIds: z.array(z.string().min(1)).min(1).max(6),
    order: z.number().int().nonnegative(),
    selected: z.boolean().default(true),
    sourceMediaId: z.string().min(1).nullable(),
    startSec: z.number().finite().nonnegative(),
    thumbKey: z.string().min(1).nullable(),
    title: z.string().min(1),
    transitionIn: transitionTypeSchema.default("crossfade"),
  })
  .strict()
  .superRefine((clip, context) => {
    if (clip.endSec <= clip.startSec) {
      context.addIssue({code: "custom", message: "endSec must exceed startSec", path: ["endSec"]});
    }
    if (Math.abs(clip.durationSec - (clip.endSec - clip.startSec)) > 0.05) {
      context.addIssue({
        code: "custom",
        message: "durationSec must match endSec - startSec",
        path: ["durationSec"],
      });
    }
    if (clip.kind === "group" && clip.groupId === null) {
      context.addIssue({code: "custom", message: "group clip requires groupId", path: ["groupId"]});
    }
    if (clip.kind === "source" && clip.sourceMediaId === null) {
      context.addIssue({
        code: "custom",
        message: "source clip requires sourceMediaId",
        path: ["sourceMediaId"],
      });
    }
  });

export type PipelineClip = z.infer<typeof pipelineClipSchema>;

export const clipManifestSchema = z
  .object({
    clips: z.array(pipelineClipSchema),
    createdAt: timestampSchema,
    projectId: z.string().min(1),
    schemaVersion: schemaVersionSchema,
  })
  .strict();

export type ClipManifest = z.infer<typeof clipManifestSchema>;

/** 그룹 클립 한 장당 노출 시간과 교차 전환 길이. 프레임 계산은 core 에서만 한다. */
export const GROUP_CLIP_TIMING = {
  crossfadeSec: 0.5,
  maxPhotosPerGroup: 5,
  minPhotosPerGroup: 2,
  perPhotoSec: 2.6,
} as const;

export const groupClipDurationSec = (photoCount: number): number =>
  Math.round(
    (photoCount * GROUP_CLIP_TIMING.perPhotoSec -
      Math.max(0, photoCount - 1) * GROUP_CLIP_TIMING.crossfadeSec) *
      1000,
  ) / 1000;
