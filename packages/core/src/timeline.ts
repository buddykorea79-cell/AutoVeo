export type CoreTransitionType = "cut" | "fade" | "crossfade";

export interface PlannedScene {
  readonly durationSec: number;
  readonly id: string;
  readonly transitionIn: {
    readonly durationSec: number;
    readonly type: CoreTransitionType;
  };
}

export type LaidOutScene<T extends PlannedScene> = Omit<T, "transitionIn"> & {
  readonly durationInFrames: number;
  readonly startFrame: number;
  readonly transitionIn: {
    readonly overlapFrames: number;
    readonly type: T["transitionIn"]["type"];
  };
  readonly visibleFrames: number;
};

export interface SceneLayout<T extends PlannedScene> {
  readonly scenes: Array<LaidOutScene<T>>;
  readonly totalFrames: number;
}

export interface MontageItemLayout {
  readonly durationInFrames: number;
  readonly fadeInFrames: number;
  readonly fadeOutFrames: number;
  readonly sourceId: string;
  readonly startFrame: number;
}

const assertFiniteNonnegative = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite nonnegative number`);
  }
};

const assertFps = (fps: number): void => {
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new RangeError("fps must be a positive integer");
  }
};

export const layoutScenes = <T extends PlannedScene>(
  scenes: readonly T[],
  fps: number,
): SceneLayout<T> => {
  assertFps(fps);

  let cursor = 0;
  const output: Array<LaidOutScene<T>> = [];

  for (const scene of scenes) {
    assertFiniteNonnegative(scene.durationSec, `Scene ${scene.id} durationSec`);
    assertFiniteNonnegative(
      scene.transitionIn.durationSec,
      `Scene ${scene.id} transition durationSec`,
    );

    const requestedOverlap =
      scene.transitionIn.type === "cut" ? 0 : Math.round(scene.transitionIn.durationSec * fps);
    const overlapFrames = Math.min(requestedOverlap, cursor);
    const minimumDuration = overlapFrames * 2 + Math.round(0.5 * fps);
    const durationInFrames = Math.max(Math.round(scene.durationSec * fps), minimumDuration);
    const startFrame = Math.max(0, cursor - overlapFrames);
    const visibleFrames = durationInFrames - overlapFrames;

    output.push({
      ...scene,
      durationInFrames,
      startFrame,
      transitionIn: {
        overlapFrames,
        type: scene.transitionIn.type,
      },
      visibleFrames,
    });

    cursor = startFrame + durationInFrames;
  }

  return {scenes: output, totalFrames: cursor};
};

export const layoutMontage = (
  sourceIds: readonly string[],
  totalFrames: number,
  fps: number,
): MontageItemLayout[] => {
  assertFps(fps);
  if (!Number.isInteger(totalFrames) || totalFrames <= 0) {
    throw new RangeError("totalFrames must be a positive integer");
  }
  if (
    sourceIds.length < 2 ||
    sourceIds.length > 5 ||
    new Set(sourceIds).size !== sourceIds.length
  ) {
    throw new RangeError("A montage requires between two and five unique sourceIds");
  }
  const maximumOverlap = Math.round(0.18 * fps);
  const overlapFrames = Math.min(maximumOverlap, Math.floor(totalFrames / (sourceIds.length * 4)));
  const rawFrames = totalFrames + overlapFrames * (sourceIds.length - 1);
  const baseDuration = Math.floor(rawFrames / sourceIds.length);
  let remainder = rawFrames % sourceIds.length;
  let cursor = 0;
  return sourceIds.map((sourceId, index) => {
    const durationInFrames = baseDuration + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    const startFrame = cursor;
    const fadeInFrames = index === 0 ? 0 : overlapFrames;
    const fadeOutFrames = index === sourceIds.length - 1 ? 0 : overlapFrames;
    cursor = startFrame + durationInFrames - fadeOutFrames;
    return {durationInFrames, fadeInFrames, fadeOutFrames, sourceId, startFrame};
  });
};

export interface CaptionScene {
  readonly durationInFrames: number;
  readonly startFrame: number;
}

export interface CaptionTiming {
  readonly durationInFrames: number;
  readonly startFrame: number;
}

export const planCaptionTiming = (scene: CaptionScene, fps: number): CaptionTiming | null => {
  assertFps(fps);

  if (!Number.isInteger(scene.startFrame) || scene.startFrame < 0) {
    throw new RangeError("scene.startFrame must be a nonnegative integer");
  }

  if (!Number.isInteger(scene.durationInFrames) || scene.durationInFrames <= 0) {
    throw new RangeError("scene.durationInFrames must be a positive integer");
  }

  const enterDelayFrames = Math.round(0.4 * fps);
  const exitLeadFrames = Math.round(0.5 * fps);
  const durationInFrames = scene.durationInFrames - enterDelayFrames - exitLeadFrames;
  const minimumReadableFrames = Math.round(1.2 * fps);

  if (durationInFrames < minimumReadableFrames) {
    return null;
  }

  return {
    durationInFrames,
    startFrame: scene.startFrame + enterDelayFrames,
  };
};

export interface AudioBoundary<T> {
  readonly startFrame: number;
  readonly value: T;
}

export const framesFromSeconds = (seconds: number, fps: number): number => {
  assertFps(fps);
  assertFiniteNonnegative(seconds, "seconds");
  return Math.round(seconds * fps);
};

export const secondsFromFrames = (frames: number, fps: number): number => {
  assertFps(fps);
  if (!Number.isInteger(frames) || frames < 0) {
    throw new RangeError("frames must be a nonnegative integer");
  }
  return frames / fps;
};

export const audioCrossfadeFrames = (
  left: {readonly durationInFrames: number; readonly fadeOutFrames: number},
  right: {readonly durationInFrames: number; readonly fadeInFrames: number},
  fps: number,
): number => {
  assertFps(fps);
  return Math.max(
    0,
    Math.min(
      Math.round(1.5 * fps),
      left.fadeOutFrames,
      right.fadeInFrames,
      Math.floor(left.durationInFrames / 2),
      Math.floor(right.durationInFrames / 2),
    ),
  );
};

export interface LaidOutAudioSegment<T> extends AudioBoundary<T> {
  readonly durationInFrames: number;
  readonly fadeInFrames: number;
  readonly fadeOutFrames: number;
}

export const layoutAudioSegments = <T>(
  boundaries: readonly AudioBoundary<T>[],
  totalFrames: number,
  fps: number,
): Array<LaidOutAudioSegment<T>> => {
  assertFps(fps);
  if (!Number.isInteger(totalFrames) || totalFrames < 0) {
    throw new RangeError("totalFrames must be a nonnegative integer");
  }
  if (boundaries.length === 0) {
    return [];
  }
  if (boundaries[0]?.startFrame !== 0) {
    throw new RangeError("The first audio boundary must start at frame 0");
  }

  const fadeFrames = Math.round(1.5 * fps);
  return boundaries.map((boundary, index) => {
    const nextStart = boundaries[index + 1]?.startFrame ?? totalFrames;
    if (
      !Number.isInteger(boundary.startFrame) ||
      boundary.startFrame < 0 ||
      boundary.startFrame >= totalFrames ||
      nextStart <= boundary.startFrame ||
      nextStart > totalFrames
    ) {
      throw new RangeError(`Invalid audio boundary at index ${String(index)}`);
    }
    const durationInFrames = nextStart - boundary.startFrame;
    const boundedFade = Math.min(fadeFrames, Math.floor(durationInFrames / 2));
    return {
      ...boundary,
      durationInFrames,
      fadeInFrames: index === 0 ? Math.min(fadeFrames, boundedFade) : boundedFade,
      fadeOutFrames: boundedFade,
    };
  });
};
