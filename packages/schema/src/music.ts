import {z} from "zod";

import {moodSchema, schemaVersionSchema, timestampSchema} from "./common.js";

export const musicMoodTagSchema = z.enum([
  "calm",
  "night",
  "upbeat",
  "emotional",
  "acoustic",
  "ambient",
  "cinematic",
]);

const relativeMusicPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !/^[a-z]:/iu.test(value) &&
      !value.split(/[\\/]+/u).includes(".."),
    "Music paths must stay inside the configured music folder",
  );

export const musicCatalogTrackSchema = z
  .object({
    attribution: z.string().trim(),
    bpm: z.number().finite().positive().nullable().default(null),
    durationSec: z.number().finite().positive().optional(),
    energy: z.number().finite().min(0).max(1),
    id: z.string().trim().min(1),
    license: z.string().trim().min(1),
    mood: z.array(musicMoodTagSchema).min(1),
    path: relativeMusicPathSchema,
    tags: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export const musicCatalogSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    tracks: z.array(musicCatalogTrackSchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    catalog.tracks.forEach((track, index) => {
      if (ids.has(track.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate music track id: ${track.id}`,
          path: ["tracks", index, "id"],
        });
      }
      ids.add(track.id);
    });
  });

export const musicTrackSchema = musicCatalogTrackSchema
  .omit({durationSec: true})
  .extend({durationSec: z.number().finite().positive()})
  .strict();

export const musicLibraryWarningSchema = z
  .object({
    code: z.enum(["duration-mismatch", "missing-file", "probe-failed"]),
    message: z.string().min(1),
    trackId: z.string().min(1),
  })
  .strict();

export const musicLibrarySchema = z
  .object({
    scannedAt: timestampSchema,
    schemaVersion: schemaVersionSchema,
    tracks: z.array(musicTrackSchema),
    warnings: z.array(musicLibraryWarningSchema),
  })
  .strict();

export const musicCandidateScoreSchema = z
  .object({
    durationMatch: z.number().finite().min(0).max(1),
    energyMatch: z.number().finite().min(0).max(1),
    moodMatch: z.number().finite().min(0).max(1),
    reason: z.string().min(1),
    score: z.number().finite().min(0).max(1),
    trackId: z.string().min(1),
  })
  .strict();

export const musicChoiceSchema = z
  .object({
    candidates: z.array(musicCandidateScoreSchema),
    direction: z.object({energy: z.number().finite().min(0).max(1), mood: moodSchema}).strict(),
    reason: z.string().min(1),
    startChapterId: z.string().min(1),
    trackId: z.string().min(1),
  })
  .strict();

export const musicSelectionWarningSchema = z
  .object({
    code: z.enum(["no-tracks", "reused-track", "track-too-short"]),
    message: z.string().min(1),
  })
  .strict();

export const musicSelectionSchema = z
  .object({
    choices: z.array(musicChoiceSchema),
    mode: z.enum(["auto", "manual", "none"]),
    schemaVersion: schemaVersionSchema,
    totalDurationSec: z.number().finite().nonnegative(),
    trackCountLimit: z.number().int().min(1).max(4),
    warnings: z.array(musicSelectionWarningSchema),
  })
  .strict();

export type MusicCatalog = z.infer<typeof musicCatalogSchema>;
export type MusicCatalogTrack = z.infer<typeof musicCatalogTrackSchema>;
export type MusicTrack = z.infer<typeof musicTrackSchema>;
export type MusicLibrary = z.infer<typeof musicLibrarySchema>;
export type MusicCandidateScore = z.infer<typeof musicCandidateScoreSchema>;
export type MusicChoice = z.infer<typeof musicChoiceSchema>;
export type MusicSelection = z.infer<typeof musicSelectionSchema>;
export type MusicSelectionMode = MusicSelection["mode"];
