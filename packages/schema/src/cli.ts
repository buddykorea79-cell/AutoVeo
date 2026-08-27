#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type {ZodType} from "zod";

import {
  analysisIndexSchema,
  jobRecordSchema,
  mediaIndexSchema,
  projectSchema,
  renderPlanSchema,
  stepRecordSchema,
  verifyReportSchema,
} from "./index.js";

const schemas = {
  "analysis-index": analysisIndexSchema,
  job: jobRecordSchema,
  "media-index": mediaIndexSchema,
  project: projectSchema,
  "render-plan": renderPlanSchema,
  step: stepRecordSchema,
  "verify-report": verifyReportSchema,
} satisfies Record<string, ZodType>;

const [documentKind, filePath] = process.argv.slice(2).filter((argument) => argument !== "--");

if (documentKind === undefined || filePath === undefined || !(documentKind in schemas)) {
  console.error(`Usage: travel-movie-schema <${Object.keys(schemas).join("|")}> <file.json>`);
  process.exitCode = 2;
} else {
  try {
    const resolvedFilePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.env.INIT_CWD ?? process.cwd(), filePath);
    const source = await readFile(resolvedFilePath, "utf8");
    const value: unknown = JSON.parse(source);
    const result = schemas[documentKind as keyof typeof schemas].safeParse(value);

    if (!result.success) {
      console.error(JSON.stringify(result.error.issues, null, 2));
      process.exitCode = 1;
    } else {
      console.log(`Valid ${documentKind}: ${filePath}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
