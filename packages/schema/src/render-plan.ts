import {z} from "zod";

import {
  captionKindSchema,
  photoMotionSchema,
  schemaVersionSchema,
  sourceAudioSchema,
  transitionTypeSchema,
} from "./common.js";
import {lookPresetSchema} from "./look.js";

export const renderCaptionSchema = z
  .object({
    durationInFrames: z.number().int().positive(),
    fadeInFrames: z.number().int().nonnegative(),
    fadeOutFrames: z.number().int().nonnegative(),
    kind: captionKindSchema,
    lines: z.array(z.string()).min(1).max(2),
    startFrame: z.number().int().nonnegative(),
    style: z.string().min(1),
    text: z.string(),
  })
  .strict();

export const renderMontageItemSchema = z
  .object({
    assetKey: z.string().min(1),
    assetUrl: z.string().min(1),
    durationInFrames: z.number().int().positive(),
    fadeInFrames: z.number().int().nonnegative(),
    fadeOutFrames: z.number().int().nonnegative(),
    mediaId: z.string().min(1),
    startFrame: z.number().int().nonnegative(),
  })
  .strict();

export const renderSceneSchema = z
  .object({
    assetKey: z.string().nullable(),
    assetUrl: z.string().min(1),
    captions: z.array(renderCaptionSchema),
    durationInFrames: z.number().int().positive(),
    id: z.string().min(1),
    look: lookPresetSchema.default("none"),
    mediaId: z.string().nullable(),
    montage: z
      .object({items: z.array(renderMontageItemSchema).min(2).max(5)})
      .strict()
      .nullable()
      .default(null),
    motion: z
      .object({
        fromRotateDeg: z.number().finite().default(0),
        fromScale: z.number().finite().positive(),
        fromX: z.number().finite(),
        fromY: z.number().finite(),
        toRotateDeg: z.number().finite().default(0),
        toScale: z.number().finite().positive(),
        toX: z.number().finite(),
        toY: z.number().finite(),
        type: photoMotionSchema,
      })
      .strict()
      .nullable(),
    sourceAudio: sourceAudioSchema,
    startFrame: z.number().int().nonnegative(),
    transitionIn: z
      .object({
        overlapFrames: z.number().int().nonnegative(),
        type: transitionTypeSchema,
      })
      .strict(),
    trimStartFrame: z.number().int().nonnegative().nullable(),
    type: z.enum(["photo", "video", "montage", "title", "color"]),
    visibleFrames: z.number().int().positive(),
  })
  .strict();

export const audioTrackSchema = z
  .object({
    duckRanges: z.array(
      z
        .object({
          durationInFrames: z.number().int().positive(),
          gainDb: z.number().finite(),
          startFrame: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    durationInFrames: z.number().int().positive(),
    fadeInFrames: z.number().int().nonnegative(),
    fadeOutFrames: z.number().int().nonnegative(),
    sourceOffsetSec: z.number().finite().nonnegative(),
    sourcePath: z.string().min(1),
    startFrame: z.number().int().nonnegative(),
    trackId: z.string().min(1),
    volumeDb: z.number().finite(),
  })
  .strict();

export const renderPlanSchema = z
  .object({
    audio: z.array(audioTrackSchema),
    fps: z.number().int().positive(),
    height: z.number().int().positive(),
    scenes: z.array(renderSceneSchema),
    schemaVersion: schemaVersionSchema,
    totalFrames: z.number().int().nonnegative(),
    width: z.number().int().positive(),
  })
  .strict()
  .superRefine((plan, context) => {
    let expectedStartFrame = 0;

    plan.scenes.forEach((scene, index) => {
      const overlap = scene.transitionIn.overlapFrames;
      const minimumDuration = overlap * 2 + Math.round(plan.fps * 0.5);

      if (scene.startFrame !== expectedStartFrame) {
        context.addIssue({
          code: "custom",
          message: `Expected startFrame ${expectedStartFrame}`,
          path: ["scenes", index, "startFrame"],
        });
      }

      if (scene.durationInFrames < minimumDuration) {
        context.addIssue({
          code: "custom",
          message: `durationInFrames must be at least ${minimumDuration}`,
          path: ["scenes", index, "durationInFrames"],
        });
      }

      if (scene.visibleFrames !== scene.durationInFrames - overlap) {
        context.addIssue({
          code: "custom",
          message: "visibleFrames must equal durationInFrames - overlapFrames",
          path: ["scenes", index, "visibleFrames"],
        });
      }

      const sceneEnd = scene.startFrame + scene.durationInFrames;
      if ((scene.type === "montage") !== (scene.montage !== null)) {
        context.addIssue({
          code: "custom",
          message: "Only montage scenes may contain montage items",
          path: ["scenes", index, "montage"],
        });
      }
      if (scene.montage !== null) {
        const montageEnd = scene.montage.items.reduce(
          (maximum, item) => Math.max(maximum, item.startFrame + item.durationInFrames),
          0,
        );
        if (montageEnd !== scene.durationInFrames) {
          context.addIssue({
            code: "custom",
            message: "Montage items must end on the scene boundary",
            path: ["scenes", index, "montage"],
          });
        }
      }
      scene.captions.forEach((caption, captionIndex) => {
        const captionEnd = caption.startFrame + caption.durationInFrames;
        if (caption.startFrame < scene.startFrame || captionEnd > sceneEnd) {
          context.addIssue({
            code: "custom",
            message: "Caption timing must stay inside its scene",
            path: ["scenes", index, "captions", captionIndex],
          });
        }
      });

      expectedStartFrame = sceneEnd - (plan.scenes[index + 1]?.transitionIn.overlapFrames ?? 0);
    });

    const lastScene = plan.scenes.at(-1);
    const expectedTotal =
      lastScene === undefined ? 0 : lastScene.startFrame + lastScene.durationInFrames;

    if (plan.totalFrames !== expectedTotal) {
      context.addIssue({
        code: "custom",
        message: `totalFrames must equal ${expectedTotal}`,
        path: ["totalFrames"],
      });
    }
  });

export type RenderCaption = z.infer<typeof renderCaptionSchema>;
export type RenderMontageItem = z.infer<typeof renderMontageItemSchema>;
export type RenderScene = z.infer<typeof renderSceneSchema>;
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export type RenderPlan = z.infer<typeof renderPlanSchema>;
