import {createHash} from "node:crypto";

import {renderPlanSchema, type RenderPlan} from "@travel-movie/schema";

import type {Step} from "../jobs/job-runner.js";
import type {RemotionRenderService} from "../services/remotion.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";
import {renderPlanKey} from "./timeline.js";

export const RENDER_CODE_VERSION = 2;

export interface RenderStepDependencies {
  readonly renderer: Pick<RemotionRenderService, "render">;
  readonly storage: StorageAdapter;
}

export interface RenderStepOutput {
  readonly outputKey: string;
  readonly planKey: string;
  readonly size: number;
  readonly totalFrames: number;
}

// Project-specific intermediate (isolated per project) — demo uses work/intermediate.mp4 at repo root (see pnpm render:demo)
export const intermediateVideoKey = (projectId: string): string =>
  `intermediate/${projectId}/intermediate.mp4`;

const visualPlan = (plan: RenderPlan): RenderPlan => renderPlanSchema.parse({...plan, audio: []});

export const renderStepInputHash = async (
  projectId: string,
  dependencies: Pick<RenderStepDependencies, "storage">,
): Promise<string> => {
  const plan = renderPlanSchema.parse(
    JSON.parse((await dependencies.storage.read(renderPlanKey(projectId))).toString("utf8")),
  );
  return createHash("sha1")
    .update(JSON.stringify(visualPlan(plan)))
    .update(`|${String(RENDER_CODE_VERSION)}`)
    .digest("hex");
};

const parseOutput = (output: unknown): RenderStepOutput => {
  const value = output as Partial<RenderStepOutput>;
  if (
    typeof value.outputKey !== "string" ||
    typeof value.planKey !== "string" ||
    typeof value.size !== "number" ||
    typeof value.totalFrames !== "number"
  ) {
    throw new Error("캐시된 무음 영상 정보가 올바르지 않습니다.");
  }
  return value as RenderStepOutput;
};

export const createRenderStep = (
  projectId: string,
  dependencies: RenderStepDependencies,
): Step => ({
  codeVersion: RENDER_CODE_VERSION,
  invalidates: ["finalize", "verify"],
  name: "render",
  outputRef: (output) => parseOutput(output).outputKey,
  restoreCached: async (output) => {
    const cached = parseOutput(output);
    if (!(await dependencies.storage.exists(cached.outputKey))) {
      throw new Error("캐시된 무음 영상 파일이 없습니다.");
    }
  },
  run: async (context) => {
    const plan = renderPlanSchema.parse(
      JSON.parse((await dependencies.storage.read(renderPlanKey(projectId))).toString("utf8")),
    );
    const silentPlan = visualPlan(plan);
    context.report({message: "사진과 자막을 무음 영상으로 만드는 중", progress: 0.01});
    const rendered = await dependencies.renderer.render(silentPlan, {
      onProgress: (progress) =>
        context.report({
          message: `무음 영상 ${String(Math.floor(progress * 100))}%`,
          progress,
        }),
      outputKey: intermediateVideoKey(projectId),
      planKey: `plans/${projectId}/silent-render-plan.json`,
      signal: context.signal,
    });
    context.report({message: "무음 영상 완성", progress: 1});
    return {
      outputKey: rendered.outputKey,
      planKey: rendered.planKey,
      size: rendered.size,
      totalFrames: silentPlan.totalFrames,
    } satisfies RenderStepOutput;
  },
});
