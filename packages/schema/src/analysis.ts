import {z} from "zod";

import {schemaVersionSchema, timestampSchema} from "./common.js";

export const analysisItemSchema = z
  .object({
    analyzedAt: timestampSchema,
    importance: z.number().finite().min(0).max(1),
    mediaId: z.string().min(1),
    model: z.string().min(1),
    sceneType: z.string().min(1),
    summary: z.string(),
    tags: z.array(z.string().min(1)),
  })
  .strict();

export const analysisIndexSchema = z
  .object({
    createdAt: timestampSchema,
    items: z.array(analysisItemSchema),
    schemaVersion: schemaVersionSchema,
  })
  .strict();

export type AnalysisItem = z.infer<typeof analysisItemSchema>;
export type AnalysisIndex = z.infer<typeof analysisIndexSchema>;
