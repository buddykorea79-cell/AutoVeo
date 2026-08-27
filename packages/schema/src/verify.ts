import {z} from "zod";

import {schemaVersionSchema, timestampSchema} from "./common.js";

const metricValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const verifyCheckSchema = z
  .object({
    message: z.string(),
    metrics: z.record(z.string(), metricValueSchema),
    name: z.string().min(1),
    status: z.enum(["pass", "fail", "warning", "skipped"]),
  })
  .strict();

export const verifyReportSchema = z
  .object({
    checks: z.array(verifyCheckSchema),
    createdAt: timestampSchema,
    outputPath: z.string().min(1),
    projectId: z.string().min(1),
    schemaVersion: schemaVersionSchema,
    status: z.enum(["pass", "fail"]),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.status === "pass" && report.checks.some((check) => check.status === "fail")) {
      context.addIssue({
        code: "custom",
        message: "A passing report cannot contain a failed check",
        path: ["status"],
      });
    }
  });

export type VerifyCheck = z.infer<typeof verifyCheckSchema>;
export type VerifyReport = z.infer<typeof verifyReportSchema>;
