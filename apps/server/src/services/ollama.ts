import sharp from "sharp";
import {z} from "zod";

import {VIDEO_CATEGORY_VALUES} from "@travel-movie/schema";

/** v2: 프레임을 줄여 보내 기본 컨텍스트(4096 토큰)를 넘지 않게 했다. */
export const OLLAMA_CLIP_CODE_VERSION = 2;

/**
 * 비전 모델에 보낼 프레임의 최대 가로 폭.
 *
 * 원본 크기 그대로 보내면 1080p 는 4,103 토큰, 4K 는 8,183 토큰이 되어
 * Ollama 기본 컨텍스트 4,096 을 넘고 HTTP 400 이 난다.
 * 768px 로 줄이면 3장을 합쳐도 2,134 토큰이라 기본 설정에서도 안전하다.
 * 모델은 어차피 내부에서 축소하므로 판단 품질은 떨어지지 않는다.
 */
export const AI_FRAME_MAX_WIDTH = 768;

/** 프레임을 줄인다. 줄이지 못하면 원본을 그대로 쓴다. */
export const shrinkFrameForAi = async (frame: Buffer): Promise<Buffer> => {
  try {
    return await sharp(frame)
      .resize({width: AI_FRAME_MAX_WIDTH, withoutEnlargement: true})
      .jpeg({quality: 80})
      .toBuffer();
  } catch {
    return frame;
  }
};

const modelDetailsSchema = z
  .object({
    family: z.string().optional(),
    families: z.array(z.string()).nullable().optional(),
    format: z.string().optional(),
    parameter_size: z.string().optional(),
    quantization_level: z.string().optional(),
  })
  .passthrough();

const tagsResponseSchema = z.object({
  models: z.array(
    z
      .object({
        capabilities: z.array(z.string()).optional(),
        details: modelDetailsSchema.optional(),
        digest: z.string().optional(),
        model: z.string().optional(),
        name: z.string().min(1),
        size: z.number().int().nonnegative(),
      })
      .passthrough(),
  ),
});

const showResponseSchema = z.object({capabilities: z.array(z.string()).default([])}).passthrough();

const chatResponseSchema = z
  .object({
    done_reason: z.string().optional(),
    message: z.object({
      content: z.string(),
      thinking: z.string().optional().nullable(),
    }),
  })
  .passthrough();

/** 클립 한 개에 대한 AI 판단. 점수·분류·설명·자막 초안을 한 번에 받는다. */
export const clipAiProposalSchema = z
  .object({
    caption: z.string().trim().max(44),
    category: z.enum(VIDEO_CATEGORY_VALUES),
    description: z.string().trim().max(120),
    score: z.number().finite().min(0).max(100),
    tags: z.array(z.string().trim().min(1).max(20)).max(6).default([]),
  })
  .strict();

export type ClipAiProposal = z.infer<typeof clipAiProposalSchema>;

export interface OllamaModelInfo {
  readonly capabilities: readonly string[];
  readonly digest: string | null;
  readonly family: string | null;
  readonly name: string;
  readonly parameterSize: string | null;
  readonly quantizationLevel: string | null;
  readonly size: number;
  readonly vision: boolean;
}

export interface OllamaModelList {
  readonly available: boolean;
  readonly baseUrl: string;
  readonly error: string | null;
  readonly models: readonly OllamaModelInfo[];
}

type FetchLike = typeof fetch;

const normalizeBaseUrl = (value: string): string => {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OLLAMA_BASE_URL must use http or https");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/u, "");
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const stripCodeFences = (text: string): string => {
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(text);
  return fence?.[1]?.trim() ?? text;
};

const extractBalancedJsonObject = (text: string): string | null => {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
};

export const parseJsonObject = (content: string): unknown => {
  for (const candidate of [content, stripCodeFences(content)]) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      // 모델이 설명을 덧붙인 경우 아래에서 객체만 잘라낸다.
    }
    const balanced = extractBalancedJsonObject(trimmed);
    if (balanced !== null) {
      try {
        return JSON.parse(balanced);
      } catch {
        // 마지막 수단으로 첫 중괄호와 마지막 중괄호 사이를 시도한다.
      }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
  }
  const preview = content.trim().slice(0, 300);
  throw new Error(
    `Ollama 응답에서 JSON 객체를 찾을 수 없습니다.${preview.length === 0 ? " (빈 응답)" : ` 미리보기: ${preview}`}`,
  );
};

/** think 모드를 켠 모델은 JSON 을 thinking 쪽에 넣기도 한다. */
const pickJsonContent = (message: {content: string; thinking?: string | null}): string => {
  const content = message.content.trim();
  const thinking = (message.thinking ?? "").trim();
  if (content.includes("{")) {
    return content;
  }
  return thinking.includes("{") ? thinking : content;
};

export interface ClipAiRequest {
  readonly durationSec: number;
  readonly imageBuffers: readonly Buffer[];
  readonly kind: "group" | "source";
  readonly model: string;
  readonly title: string;
}

export class OllamaService {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(baseUrl: string, fetcher: FetchLike = fetch) {
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    this.#fetch = fetcher;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async listModels(signal?: AbortSignal): Promise<OllamaModelList> {
    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/tags`, {
        signal: this.#requestSignal(signal, 5_000),
      });
      if (!response.ok) {
        throw new Error(`Ollama model list returned HTTP ${String(response.status)}`);
      }
      const tags = tagsResponseSchema.parse(await response.json());
      const models = await Promise.all(
        tags.models.map(async (model): Promise<OllamaModelInfo> => {
          const shown = await this.#capabilities(model.name, signal);
          const capabilities = shown.length > 0 ? shown : (model.capabilities ?? []);
          return {
            capabilities,
            digest: model.digest ?? null,
            family: model.details?.family ?? null,
            name: model.name,
            parameterSize: model.details?.parameter_size ?? null,
            quantizationLevel: model.details?.quantization_level ?? null,
            size: model.size,
            vision: capabilities.includes("vision"),
          };
        }),
      );
      return {
        available: true,
        baseUrl: this.#baseUrl,
        error: null,
        models: models.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    } catch (error) {
      return {available: false, baseUrl: this.#baseUrl, error: errorMessage(error), models: []};
    }
  }

  /** 클립 대표 프레임을 보고 편집 가치 점수와 한국어 자막 초안을 받는다. */
  async analyzeClip(input: ClipAiRequest, signal?: AbortSignal): Promise<ClipAiProposal> {
    if (input.imageBuffers.length === 0 || input.imageBuffers.length > 4) {
      throw new Error("클립 분석에는 1~4장의 프레임이 필요합니다.");
    }
    const frames = await Promise.all(input.imageBuffers.map(shrinkFrameForAi));
    const prompt = [
      "당신은 여행 영상 편집자입니다. 입력 이미지는 같은 영상 클립에서 뽑은 대표 프레임입니다.",
      "보이는 것만 근거로 판단하고, 장소명·인물 관계·사건을 지어내지 마세요.",
      "score: 이 클립을 최종 영상에 쓸 가치. 0~100 사이에서 변별력 있게 매기세요.",
      `category: ${VIDEO_CATEGORY_VALUES.join(" | ")} 중 하나.`,
      "description: 무엇이 보이는지 한국어 60자 이내로.",
      "caption: 영상에 얹을 한국어 자막 초안. 22자 이하 한 문장. 확인 가능한 내용만.",
      "tags: 영어 소문자 키워드 최대 6개.",
      "설명이나 코드펜스 없이 JSON 객체 하나만 출력하세요.",
      `클립 정보: 제목=${input.title} 길이=${input.durationSec.toFixed(1)}초 종류=${
        input.kind === "group" ? "사진 그룹으로 만든 클립" : "촬영 영상 구간"
      }`,
      '예시: {"caption":"해질 무렵 바닷가 산책","category":"landscape_reveal","description":"노을이 든 해변과 걷는 사람","score":82,"tags":["beach","sunset"]}',
    ].join("\n");

    const response = await this.#fetch(`${this.#baseUrl}/api/chat`, {
      body: JSON.stringify({
        format: "json",
        messages: [
          {
            content: prompt,
            images: frames.map((buffer) => buffer.toString("base64")),
            role: "user",
          },
        ],
        model: input.model,
        options: {num_predict: 320, repeat_penalty: 1.1, temperature: 0.2},
        stream: false,
        think: false,
      }),
      headers: {"Content-Type": "application/json"},
      method: "POST",
      signal: this.#requestSignal(signal, 120_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Ollama 클립 분석이 HTTP ${String(response.status)} 를 반환했습니다${body.length === 0 ? "" : `: ${body.slice(0, 200)}`}`,
      );
    }
    const parsed = chatResponseSchema.parse(await response.json());
    const raw = parseJsonObject(pickJsonContent(parsed.message));
    try {
      return clipAiProposalSchema.parse(raw);
    } catch (error) {
      const issues =
        error instanceof z.ZodError
          ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
          : errorMessage(error);
      throw new Error(
        `Ollama 응답이 스키마를 만족하지 않습니다: ${issues}. 받은 값: ${JSON.stringify(raw).slice(0, 300)}`,
        {cause: error},
      );
    }
  }

  async #capabilities(model: string, signal?: AbortSignal): Promise<readonly string[]> {
    const response = await this.#fetch(`${this.#baseUrl}/api/show`, {
      body: JSON.stringify({model}),
      headers: {"Content-Type": "application/json"},
      method: "POST",
      signal: this.#requestSignal(signal, 5_000),
    });
    if (!response.ok) {
      return [];
    }
    return showResponseSchema.parse(await response.json()).capabilities;
  }

  #requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }
}
