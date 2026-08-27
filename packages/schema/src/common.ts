import {z} from "zod";

export const SCHEMA_VERSION = 2 as const;
export const schemaVersionSchema = z.literal(SCHEMA_VERSION);

export const localDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u,
    "Expected a timezone-free local ISO date-time",
  );

export const timestampSchema = z.string().min(1);

export const timeSourceSchema = z.enum([
  "exif-with-offset",
  "exif-naive",
  "quicktime-local",
  "mp4-utc-converted",
  "filesystem",
  "user-override",
]);

export const orientationSchema = z.enum(["landscape", "portrait", "square"]);
export const userDecisionSchema = z.enum(["auto", "include", "exclude"]);
export const sourceAudioSchema = z.enum(["mute", "duck", "mix"]);
export const transitionTypeSchema = z.enum(["cut", "fade", "crossfade"]);
export const captionKindSchema = z.enum(["chapter-title", "location-date", "scene-caption"]);
export const captionSourceSchema = z.enum(["ai", "rule", "user"]);
export const moodSchema = z.enum(["calm", "night", "upbeat", "emotional"]);
export const photoMotionSchema = z.enum([
  "static",
  "slow-push-in",
  "zoom-in",
  "zoom-out",
  "pan-left",
  "pan-right",
]);

export type TimeSource = z.infer<typeof timeSourceSchema>;
export type Orientation = z.infer<typeof orientationSchema>;
export type UserDecision = z.infer<typeof userDecisionSchema>;
export type SourceAudio = z.infer<typeof sourceAudioSchema>;
export type TransitionType = z.infer<typeof transitionTypeSchema>;
export type CaptionKind = z.infer<typeof captionKindSchema>;
export type CaptionSource = z.infer<typeof captionSourceSchema>;
export type Mood = z.infer<typeof moodSchema>;
export type PhotoMotion = z.infer<typeof photoMotionSchema>;
