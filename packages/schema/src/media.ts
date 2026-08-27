import {z} from "zod";

import {
  localDateTimeSchema,
  orientationSchema,
  schemaVersionSchema,
  timeSourceSchema,
  timestampSchema,
  userDecisionSchema,
} from "./common.js";

export const gpsSchema = z
  .object({
    alt: z.number().finite().nullable(),
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180),
  })
  .strict();

export const placeSchema = z
  .object({
    area: z.string().nullable(),
    city: z.string().nullable(),
    confidence: z.enum(["exact", "city", "unknown"]),
    country: z.string().nullable(),
    source: z.enum(["exif-gps", "user", "none"]),
  })
  .strict();

export const videoMetadataSchema = z
  .object({
    audioCodec: z.string().nullable(),
    bitrate: z.number().nonnegative().nullable(),
    durationSec: z.number().finite().positive(),
    fps: z.number().finite().positive(),
    hasAudio: z.boolean(),
    videoCodec: z.string().min(1),
  })
  .strict();

export const livePhotoSchema = z
  .object({
    pairId: z.string().min(1),
    role: z.enum(["still", "motion"]),
  })
  .strict();

export const mediaItemSchema = z
  .object({
    absolutePath: z.string().min(1),
    analysisKey: z.string().nullable(),
    blurScore: z.number().finite().min(0).max(1).nullable(),
    capturedAtLocal: localDateTimeSchema,
    clusterId: z.string().nullable(),
    contentHash: z.string().min(1),
    dhash: z
      .string()
      .regex(/^[0-9a-f]{16}$/iu)
      .nullable(),
    exposureScore: z.number().finite().min(0).max(1).nullable(),
    ext: z.string().min(1),
    filename: z.string().min(1),
    fileSize: z.number().int().nonnegative(),
    gps: gpsSchema.nullable(),
    height: z.number().int().positive(),
    id: z.string().min(1),
    isClusterBest: z.boolean(),
    issues: z.array(z.string()),
    livePhoto: livePhotoSchema.nullable(),
    mediaType: z.enum(["photo", "video"]),
    orientation: orientationSchema,
    place: placeSchema.nullable(),
    proxyKey: z.string().nullable(),
    relativePath: z.string().min(1),
    renderAssetKey: z.string().nullable(),
    rotationApplied: z.boolean(),
    status: z.enum(["ok", "warning", "error"]),
    thumbKey: z.string().nullable(),
    timeSource: timeSourceSchema,
    userDecision: userDecisionSchema.default("auto"),
    utcOffsetMin: z
      .number()
      .int()
      .min(-14 * 60)
      .max(14 * 60)
      .nullable(),
    video: videoMetadataSchema.nullable(),
    width: z.number().int().positive(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.mediaType === "video" && item.video === null) {
      context.addIssue({
        code: "custom",
        message: "Video media requires video metadata",
        path: ["video"],
      });
    }

    if (item.mediaType === "photo" && item.video !== null) {
      context.addIssue({
        code: "custom",
        message: "Photo media cannot contain video metadata",
        path: ["video"],
      });
    }
  });

export const mediaIndexSchema = z
  .object({
    createdAt: timestampSchema,
    items: z.array(mediaItemSchema),
    schemaVersion: schemaVersionSchema,
    sourceRoot: z.string().min(1),
  })
  .strict();

export type Gps = z.infer<typeof gpsSchema>;
export type Place = z.infer<typeof placeSchema>;
export type VideoMetadata = z.infer<typeof videoMetadataSchema>;
export type LivePhoto = z.infer<typeof livePhotoSchema>;
export type MediaItem = z.infer<typeof mediaItemSchema>;
export type MediaIndex = z.infer<typeof mediaIndexSchema>;
