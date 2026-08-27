import {layoutScenes} from "@travel-movie/core";
import {
  CLIP_STYLE_TIMING,
  renderPlanSchema,
  type ClipStyle,
  type RenderPlan,
  type RenderScene,
} from "@travel-movie/schema";

import type {RemotionRenderService} from "./remotion.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";

/** 움직임 규칙을 바꾸면 이 번호를 올려 이전 클립 캐시를 무효화한다. */
export const GROUP_CLIP_REMOTION_CODE_VERSION = 1;

type Motion = NonNullable<RenderScene["motion"]>;

/**
 * 스타일별 카메라 움직임. 사진 순서대로 돌아가며 쓴다.
 *
 * - simple: 거의 정지. 아주 느리게 밀어 들어가기만 한다.
 * - standard: 방향을 바꿔 가며 천천히 밀고 당기고 좌우로 움직인다.
 * - dynamic: 확대 폭이 크고 대각선으로 움직이며 살짝 기운다.
 */
const MOTION_CYCLES: Readonly<Record<ClipStyle, readonly Motion[]>> = {
  dynamic: [
    {
      fromRotateDeg: -1.4,
      fromScale: 1.02,
      fromX: -0.05,
      fromY: 0.03,
      toRotateDeg: 0.6,
      toScale: 1.3,
      toX: 0.04,
      toY: -0.03,
      type: "zoom-in",
    },
    {
      fromRotateDeg: 1.2,
      fromScale: 1.3,
      fromX: 0.05,
      fromY: -0.02,
      toRotateDeg: -0.8,
      toScale: 1.04,
      toX: -0.04,
      toY: 0.03,
      type: "zoom-out",
    },
    {
      fromRotateDeg: -0.9,
      fromScale: 1.2,
      fromX: -0.07,
      fromY: -0.03,
      toRotateDeg: 0.9,
      toScale: 1.2,
      toX: 0.07,
      toY: 0.03,
      type: "pan-right",
    },
    {
      fromRotateDeg: 0.9,
      fromScale: 1.22,
      fromX: 0.07,
      fromY: 0.03,
      toRotateDeg: -0.9,
      toScale: 1.22,
      toX: -0.07,
      toY: -0.03,
      type: "pan-left",
    },
  ],
  simple: [
    {
      fromRotateDeg: 0,
      fromScale: 1,
      fromX: 0,
      fromY: 0,
      toRotateDeg: 0,
      toScale: 1.045,
      toX: 0,
      toY: 0,
      type: "slow-push-in",
    },
    {
      fromRotateDeg: 0,
      fromScale: 1.045,
      fromX: 0,
      fromY: 0,
      toRotateDeg: 0,
      toScale: 1,
      toX: 0,
      toY: 0,
      type: "zoom-out",
    },
  ],
  standard: [
    {
      fromRotateDeg: 0,
      fromScale: 1,
      fromX: 0,
      fromY: 0,
      toRotateDeg: 0,
      toScale: 1.16,
      toX: 0,
      toY: 0,
      type: "zoom-in",
    },
    {
      fromRotateDeg: 0,
      fromScale: 1.14,
      fromX: -0.045,
      fromY: 0,
      toRotateDeg: 0,
      toScale: 1.14,
      toX: 0.045,
      toY: 0,
      type: "pan-right",
    },
    {
      fromRotateDeg: 0,
      fromScale: 1.16,
      fromX: 0,
      fromY: 0,
      toRotateDeg: 0,
      toScale: 1,
      toX: 0,
      toY: 0,
      type: "zoom-out",
    },
    {
      fromRotateDeg: 0,
      fromScale: 1.14,
      fromX: 0.045,
      fromY: 0,
      toRotateDeg: 0,
      toScale: 1.14,
      toX: -0.045,
      toY: 0,
      type: "pan-left",
    },
  ],
};

export const motionForStyle = (style: ClipStyle, index: number): Motion => {
  const cycle = MOTION_CYCLES[style];
  return cycle[index % cycle.length]!;
};

export interface GroupClipPlanInput {
  readonly fps: number;
  readonly height: number;
  /** 렌더용 고화질 사진의 storage key. 순서가 곧 등장 순서다. */
  readonly photoKeys: readonly string[];
  readonly style: ClipStyle;
  readonly width: number;
}

/**
 * 그룹 클립을 최종 영상과 같은 렌더 계획으로 표현한다.
 * 클립 전용 컴포지션을 따로 만들지 않고 기존 TravelMovie 를 그대로 쓴다.
 */
export const buildGroupClipPlan = (
  input: GroupClipPlanInput,
  storage: Pick<StorageAdapter, "publicUrl">,
): RenderPlan => {
  if (input.photoKeys.length === 0) {
    throw new Error("클립을 만들려면 사진이 최소 한 장 필요합니다.");
  }
  const timing = CLIP_STYLE_TIMING[input.style];
  const layout = layoutScenes(
    input.photoKeys.map((assetKey, index) => ({
      assetKey,
      durationSec: timing.perPhotoSec,
      id: `p${String(index)}`,
      index,
      transitionIn: {
        durationSec: index === 0 ? 0 : timing.crossfadeSec,
        type: index === 0 ? ("cut" as const) : ("crossfade" as const),
      },
    })),
    input.fps,
  );

  return renderPlanSchema.parse({
    audio: [],
    fps: input.fps,
    height: input.height,
    scenes: layout.scenes.map((scene) => ({
      assetKey: scene.assetKey,
      assetUrl: storage.publicUrl(scene.assetKey),
      captions: [],
      durationInFrames: scene.durationInFrames,
      id: scene.id,
      look: "none",
      mediaId: scene.id,
      montage: null,
      motion: motionForStyle(input.style, scene.index),
      sourceAudio: "mute",
      startFrame: scene.startFrame,
      transitionIn: scene.transitionIn,
      trimStartFrame: null,
      type: "photo",
      visibleFrames: scene.visibleFrames,
    })),
    schemaVersion: 2,
    totalFrames: layout.totalFrames,
    width: input.width,
  });
};

export interface RenderGroupClipInput extends GroupClipPlanInput {
  readonly outputKey: string;
  readonly planKey: string;
}

/**
 * 사진 그룹을 Remotion 으로 렌더해 mp4 클립을 만든다.
 * ffmpeg zoompan 으로는 표현할 수 없는 회전·대각선 이동까지 쓸 수 있다.
 */
export const renderGroupClipWithRemotion = async (
  input: RenderGroupClipInput,
  storage: StorageAdapter,
  renderer: Pick<RemotionRenderService, "render">,
  signal?: AbortSignal,
): Promise<{durationSec: number; outputKey: string}> => {
  const plan = buildGroupClipPlan(input, storage);
  await renderer.render(plan, {
    outputKey: input.outputKey,
    planKey: input.planKey,
    signal,
  });
  return {
    durationSec: Math.round((plan.totalFrames / plan.fps) * 1000) / 1000,
    outputKey: input.outputKey,
  };
};
