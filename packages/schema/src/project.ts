import {z} from "zod";

import {
  captionKindSchema,
  captionSourceSchema,
  moodSchema,
  photoMotionSchema,
  schemaVersionSchema,
  sourceAudioSchema,
  timestampSchema,
  transitionTypeSchema,
} from "./common.js";
import {lookPresetSchema} from "./look.js";

export const projectCaptionSchema = z
  .object({
    kind: captionKindSchema,
    source: captionSourceSchema,
    text: z.string(),
  })
  .strict();

export const sceneEffectSchema = z
  .object({
    kind: z.enum(["burst-montage", "comfy-i2v"]),
    negativePrompt: z.string().max(2_000).nullable().default(null),
    prompt: z.string().max(2_000).nullable().default(null),
    seed: z.number().int().nonnegative().default(0),
    sourceMediaIds: z.array(z.string().min(1)).min(1).max(5),
  })
  .strict()
  .superRefine((effect, context) => {
    if (effect.kind === "burst-montage" && effect.sourceMediaIds.length < 2) {
      context.addIssue({
        code: "custom",
        message: "burst-montage requires at least two sourceMediaIds",
        path: ["sourceMediaIds"],
      });
    }
  });

export const projectSceneSchema = z
  .object({
    caption: projectCaptionSchema.nullable(),
    durationSec: z.number().finite().positive(),
    effect: sceneEffectSchema.nullable().default(null),
    id: z.string().min(1),
    importance: z.number().finite().min(0).max(1),
    locked: z.boolean().default(false),
    look: lookPresetSchema.default("none"),
    mediaId: z.string().min(1),
    motion: photoMotionSchema,
    remotionPrompt: z.string().max(500).nullable().default(null),
    role: z.enum(["opening", "highlight", "filler", "bridge", "closing"]),
    sourceAudio: sourceAudioSchema.default("mute"),
    transitionIn: transitionTypeSchema,
    trim: z
      .object({
        endSec: z.number().finite().nonnegative(),
        startSec: z.number().finite().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((scene, context) => {
    if (scene.trim !== null && scene.trim.endSec <= scene.trim.startSec) {
      context.addIssue({
        code: "custom",
        message: "trim.endSec must be greater than trim.startSec",
        path: ["trim", "endSec"],
      });
    }
  });

export const segmentGeneratedVideoSchema = z
  .object({
    assetKey: z.string().min(1),
    createdAt: timestampSchema,
    durationSec: z.number().finite().positive(),
    inputHash: z.string().min(1),
    prompt: z.string().max(2_000),
    sourceMediaIds: z.array(z.string().min(1)).min(1).max(5),
  })
  .strict();

export const projectChapterSchema = z
  .object({
    caption: projectCaptionSchema.nullable().default(null),
    dateLocal: z.string().nullable(),
    generatedVideo: segmentGeneratedVideoSchema.nullable().default(null),
    id: z.string().min(1),
    mood: moodSchema,
    musicDirection: z
      .object({
        energy: z.number().finite().min(0).max(1),
        mood: moodSchema,
      })
      .strict(),
    place: z.string().nullable(),
    scenes: z.array(projectSceneSchema),
    title: z.string().min(1),
  })
  .strict();

export const projectSchema = z
  .object({
    budget: z
      .object({
        photoBaseSec: z.number().finite().positive().default(3.6),
        photoMaxSec: z.number().finite().positive().default(6),
        targetDurationSec: z.number().finite().positive(),
        targetSceneCount: z.number().int().positive(),
        videoMaxSec: z.number().finite().positive().default(8),
      })
      .strict(),
    chapters: z.array(projectChapterSchema),
    id: z.string().min(1),
    output: z
      .object({
        aspect: z.enum(["16:9", "9:16", "1:1"]),
        fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
        resolution: z.enum(["720p", "1080p", "4k"]),
      })
      .strict(),
    schemaVersion: schemaVersionSchema,
    style: z.enum(["cinematic-travel", "bright-vlog", "family"]),
    title: z.string().min(1),
  })
  .strict()
  .superRefine((project, context) => {
    if (project.budget.photoMaxSec < project.budget.photoBaseSec) {
      context.addIssue({
        code: "custom",
        message: "photoMaxSec must be greater than or equal to photoBaseSec",
        path: ["budget", "photoMaxSec"],
      });
    }
  });

export type ProjectCaption = z.infer<typeof projectCaptionSchema>;
export type SceneEffect = z.infer<typeof sceneEffectSchema>;
export type ProjectScene = z.infer<typeof projectSceneSchema>;
export type SegmentGeneratedVideo = z.infer<typeof segmentGeneratedVideoSchema>;
export type ProjectChapter = z.infer<typeof projectChapterSchema>;
export type Project = z.infer<typeof projectSchema>;
