import {z} from "zod";

import {captionKindSchema, schemaVersionSchema} from "./common.js";

export const subtitleProposalSchema = z
  .object({
    chapterId: z.string().min(1).nullable().default(null),
    kind: captionKindSchema,
    lines: z.array(z.string()).min(1).max(2),
    sceneId: z.string().min(1).nullable().default(null),
    text: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.chapterId === null && value.sceneId === null) {
      context.addIssue({
        code: "custom",
        message: "Either chapterId or sceneId must be present",
        path: ["chapterId"],
      });
    }
  });

export const subtitleWarningSchema = z
  .object({
    chapterId: z.string().min(1).nullable().default(null),
    code: z.enum(["below-target-coverage", "text-overflow", "user-coverage-overflow"]),
    message: z.string().min(1),
    sceneId: z.string().min(1).nullable().default(null),
  })
  .strict();

export const subtitleManifestSchema = z
  .object({
    proposals: z.array(subtitleProposalSchema),
    schemaVersion: schemaVersionSchema,
    warnings: z.array(subtitleWarningSchema),
  })
  .strict();

export type SubtitleProposal = z.infer<typeof subtitleProposalSchema>;
export type SubtitleWarning = z.infer<typeof subtitleWarningSchema>;
export type SubtitleManifest = z.infer<typeof subtitleManifestSchema>;
