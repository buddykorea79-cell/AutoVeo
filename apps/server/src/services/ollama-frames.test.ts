import {describe, expect, it} from "vitest";
import sharp from "sharp";
import {AI_FRAME_MAX_WIDTH, OllamaService, shrinkFrameForAi} from "./ollama.js";

describe("AI 프레임 축소", () => {
  it("1920x1080 프레임을 768px 로 줄인다", async () => {
    const big = await sharp({
      create: {background: {b: 60, g: 120, r: 200}, channels: 3, height: 1080, width: 1920},
    })
      .jpeg()
      .toBuffer();
    const small = await shrinkFrameForAi(big);
    const meta = await sharp(small).metadata();
    console.log(
      `원본 ${Math.round(big.length / 1024)}KB 1920x1080 → 축소 ${Math.round(small.length / 1024)}KB ${meta.width}x${meta.height}`,
    );
    expect(meta.width).toBe(AI_FRAME_MAX_WIDTH);
  });

  it("이미 작은 프레임은 키우지 않는다", async () => {
    const small = await sharp({
      create: {background: "#123456", channels: 3, height: 200, width: 320},
    })
      .jpeg()
      .toBuffer();
    expect((await sharp(await shrinkFrameForAi(small)).metadata()).width).toBe(320);
  });

  it("analyzeClip 이 축소된 이미지를 보낸다", async () => {
    const big = await sharp({
      create: {background: "#abcdef", channels: 3, height: 1080, width: 1920},
    })
      .jpeg()
      .toBuffer();
    let sentWidths: number[] = [];
    const fake: typeof fetch = async (_url, init) => {
      const body = JSON.parse((init as {body: string}).body) as {messages: {images: string[]}[]};
      sentWidths = await Promise.all(
        body.messages[0]!.images.map(
          async (b64) => (await sharp(Buffer.from(b64, "base64")).metadata()).width!,
        ),
      );
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              caption: "자막",
              category: "general",
              description: "설명",
              score: 80,
              tags: [],
            }),
          },
        }),
        {status: 200},
      );
    };
    const service = new OllamaService("http://127.0.0.1:11434", fake);
    const result = await service.analyzeClip({
      durationSec: 5,
      imageBuffers: [big, big, big],
      kind: "group",
      model: "m",
      title: "t",
    });
    console.log("모델에 보낸 이미지 폭:", sentWidths.join(","));
    expect(sentWidths).toEqual([768, 768, 768]);
    expect(result.caption).toBe("자막");
  });
});
