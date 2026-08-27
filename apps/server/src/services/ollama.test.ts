import {describe, expect, it, vi} from "vitest";

import {OllamaService} from "./ollama.js";

describe("OllamaService", () => {
  it("lists installed models and marks vision capability from api/show", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return Response.json({
          models: [
            {
              details: {family: "qwen3vl", parameter_size: "4.4B", quantization_level: "Q4_K_M"},
              name: "qwen3-vl:4b",
              size: 3_300_000_000,
            },
            {details: {family: "qwen3"}, name: "qwen3:4b", size: 2_500_000_000},
          ],
        });
      }
      const body = JSON.parse(String(init?.body)) as {model: string};
      return Response.json({
        capabilities: body.model === "qwen3-vl:4b" ? ["completion", "vision"] : ["completion"],
      });
    });
    const result = await new OllamaService("http://local.test", fetcher).listModels();

    expect(result.available).toBe(true);
    expect(result.models.map(({name, vision}) => ({name, vision}))).toEqual([
      {name: "qwen3-vl:4b", vision: true},
      {name: "qwen3:4b", vision: false},
    ]);
  });

  it("parses a clip proposal and forwards the frames as base64 images", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        format: unknown;
        messages: Array<{images: string[]}>;
      };
      expect(body.format).toBe("json");
      expect(body.messages[0]?.images).toEqual([Buffer.from("frame").toString("base64")]);
      return Response.json({
        message: {
          content: JSON.stringify({
            caption: "바닷가를 걷는 순간",
            category: "landscape_reveal",
            description: "노을이 든 해변",
            score: 84,
            tags: ["beach", "sunset"],
          }),
        },
      });
    });

    const proposal = await new OllamaService("http://local.test", fetcher).analyzeClip({
      durationSec: 6,
      imageBuffers: [Buffer.from("frame")],
      kind: "group",
      model: "qwen3-vl:4b",
      title: "장면 1",
    });

    expect(proposal).toEqual({
      caption: "바닷가를 걷는 순간",
      category: "landscape_reveal",
      description: "노을이 든 해변",
      score: 84,
      tags: ["beach", "sunset"],
    });
  });

  it("recovers a JSON object wrapped in model commentary", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        message: {
          content:
            '분석 결과입니다.\n```json\n{"caption":"산책","category":"general","description":"길","score":70,"tags":[]}\n```\n이상입니다.',
        },
      }),
    );

    const proposal = await new OllamaService("http://local.test", fetcher).analyzeClip({
      durationSec: 4,
      imageBuffers: [Buffer.from("frame")],
      kind: "source",
      model: "qwen3-vl:4b",
      title: "clip.mp4",
    });

    expect(proposal.caption).toBe("산책");
    expect(proposal.score).toBe(70);
  });

  it("rejects a request with no frames", async () => {
    const service = new OllamaService("http://local.test", vi.fn<typeof fetch>());
    await expect(
      service.analyzeClip({
        durationSec: 4,
        imageBuffers: [],
        kind: "source",
        model: "qwen3-vl:4b",
        title: "clip.mp4",
      }),
    ).rejects.toThrow("1~4장의 프레임");
  });
});
