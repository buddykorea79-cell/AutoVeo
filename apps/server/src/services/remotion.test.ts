import {describe, expect, it} from "vitest";

import {remotionWorkerArguments} from "./remotion.js";

describe("remotionWorkerArguments", () => {
  it("uses an absolute tsx loader URL for a TypeScript development worker", () => {
    expect(
      remotionWorkerArguments(
        "C:\\workspace\\apps\\server\\src\\services\\remotion-worker.ts",
        "C:\\temp\\request.json",
        "file:///C:/workspace/apps/server/node_modules/tsx/dist/loader.mjs",
      ),
    ).toEqual([
      "--import",
      "file:///C:/workspace/apps/server/node_modules/tsx/dist/loader.mjs",
      "C:\\workspace\\apps\\server\\src\\services\\remotion-worker.ts",
      "C:\\temp\\request.json",
    ]);
  });

  it("runs a compiled JavaScript worker without a TypeScript loader", () => {
    expect(
      remotionWorkerArguments(
        "/workspace/apps/server/dist/services/remotion-worker.js",
        "/tmp/request.json",
      ),
    ).toEqual(["/workspace/apps/server/dist/services/remotion-worker.js", "/tmp/request.json"]);
  });
});
