import {z} from "zod";

import {schemaVersionSchema, timestampSchema} from "./common.js";

export const jobStateSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const stepStateSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "cached",
  "invalidated",
]);

export const jobRecordSchema = z
  .object({
    createdAt: timestampSchema,
    currentStep: z.string().nullable(),
    error: z.string().nullable(),
    id: z.string().min(1),
    projectId: z.string().min(1),
    schemaVersion: schemaVersionSchema,
    state: jobStateSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const stepRecordSchema = z
  .object({
    cacheKey: z.string().min(1),
    codeVersion: z.number().int().positive(),
    error: z.string().nullable(),
    finishedAt: timestampSchema.nullable(),
    inputHash: z.string().min(1),
    jobId: z.string().min(1),
    message: z.string().nullable(),
    outputRef: z.string().nullable(),
    paramsHash: z.string().min(1),
    progress: z.number().finite().min(0).max(1),
    schemaVersion: schemaVersionSchema,
    startedAt: timestampSchema.nullable(),
    state: stepStateSchema,
    stepName: z.string().min(1),
  })
  .strict();

export type JobState = z.infer<typeof jobStateSchema>;
export type StepState = z.infer<typeof stepStateSchema>;
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type StepRecord = z.infer<typeof stepRecordSchema>;
