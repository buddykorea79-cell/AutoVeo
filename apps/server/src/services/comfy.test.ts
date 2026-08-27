import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {LocalFsAdapter} from "../storage/local-fs-adapter.js";
import {ComfyService} from "./comfy.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("ComfyService", () => {
  it("rejects a non-local ComfyUI address", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-comfy-local-test-"));
    cleanups.push(() => rm(root, {force: true, recursive: true}));

    expect(
      () =>
        new ComfyService({
          baseUrl: "https://example.com:8188",
          probe: {probe: async () => ({format: {}, streams: []})},
          storage: new LocalFsAdapter(path.join(root, "storage")),
          workflowPath: path.join(root, "workflow.json"),
        }),
    ).toThrow("ComfyUI 주소는 localhost, 127.0.0.1 또는 ::1이어야 합니다.");
  });

  it("reports missing workflow placeholders before contacting ComfyUI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-comfy-status-test-"));
    cleanups.push(() => rm(root, {force: true, recursive: true}));
    const workflowPath = path.join(root, "workflow.json");
    await writeFile(
      workflowPath,
      JSON.stringify({"1": {class_type: "LoadImage", inputs: {image: "{{INPUT_IMAGE}}"}}}),
    );
    const fetcher = vi.fn<typeof fetch>();
    const service = new ComfyService({
      baseUrl: "http://localhost:8188",
      fetcher,
      probe: {probe: async () => ({format: {}, streams: []})},
      storage: new LocalFsAdapter(path.join(root, "storage")),
      workflowPath,
    });

    const status = await service.status();

    expect(status.available).toBe(false);
    expect(status.error).toContain("{{OUTPUT_PREFIX}}");
    expect(status.error).toContain("{{PROMPT}}");
    expect(status.error).toContain("{{TARGET_FRAMES}}");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("replaces workflow placeholders, stores an MP4, and reuses its cache", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-comfy-test-"));
    cleanups.push(() => rm(root, {force: true, recursive: true}));
    const workflowPath = path.join(root, "workflow.json");
    await writeFile(
      workflowPath,
      JSON.stringify({
        "1": {
          class_type: "TestNode",
          inputs: {
            frames: "{{TARGET_FRAMES}}",
            image: "{{INPUT_IMAGE}}",
            output: "{{OUTPUT_PREFIX}}",
            prompt: "{{PROMPT}}",
          },
        },
      }),
    );
    let submittedWorkflow: unknown = null;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/upload/image")) {
        return Response.json({name: "input.jpg", subfolder: "", type: "input"});
      }
      if (url.endsWith("/prompt")) {
        submittedWorkflow = (JSON.parse(String(init?.body)) as {prompt: unknown}).prompt;
        return Response.json({prompt_id: "prompt-1"});
      }
      if (url.includes("/history/prompt-1")) {
        return Response.json({
          "prompt-1": {
            outputs: {"9": {videos: [{filename: "result.mp4", subfolder: "", type: "output"}]}},
          },
        });
      }
      if (url.includes("/view?")) {
        return new Response(Uint8Array.from([0, 1, 2, 3]));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const storage = new LocalFsAdapter(path.join(root, "storage"));
    const service = new ComfyService({
      baseUrl: "http://127.0.0.1:8188",
      fetcher,
      probe: {
        probe: async () => ({format: {duration: "3.1"}, streams: [{codec_type: "video"}]}),
      },
      storage,
      workflowPath,
    });
    const input = {
      fps: 30,
      height: 1080,
      inputHash: "source-hash",
      negativePrompt: "warped",
      projectId: "p_test",
      prompt: "slow camera move",
      sceneId: "s_test",
      seed: 7,
      sourceBuffer: Buffer.from("image"),
      sourceFilename: "input.jpg",
      targetFrames: 90,
      width: 1920,
    } as const;
    const first = await service.generateClip(input);
    const requestCount = fetcher.mock.calls.length;
    const second = await service.generateClip(input);

    expect(first).toBe(second);
    expect(await storage.exists(first)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(requestCount);
    expect(submittedWorkflow).toMatchObject({
      "1": {
        inputs: {
          frames: 90,
          image: expect.stringMatching(/input\.jpg$/u),
          output: expect.stringMatching(/^travel_/u),
          prompt: "slow camera move",
        },
      },
    });
  });
});
