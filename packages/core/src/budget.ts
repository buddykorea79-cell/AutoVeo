export interface SceneBudgetOptions {
  readonly averageOverlapSec?: number;
  readonly photoBaseSec?: number;
  readonly photoMaxSec?: number;
  readonly videoMaxSec?: number;
}

export interface SceneBudget {
  readonly photoBaseSec: number;
  readonly photoMaxSec: number;
  readonly targetDurationSec: number;
  readonly targetSceneCount: number;
  readonly videoMaxSec: number;
}

const readPositive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }

  return value;
};

export const computeSceneBudget = (
  targetSec: number,
  options: SceneBudgetOptions = {},
): SceneBudget => {
  const targetDurationSec = readPositive(targetSec, "targetSec");
  const photoBaseSec = readPositive(options.photoBaseSec ?? 3.6, "photoBaseSec");
  const photoMaxSec = readPositive(options.photoMaxSec ?? 6, "photoMaxSec");
  const videoMaxSec = readPositive(options.videoMaxSec ?? 8, "videoMaxSec");
  const averageOverlapSec = options.averageOverlapSec ?? 0.3;

  if (!Number.isFinite(averageOverlapSec) || averageOverlapSec < 0) {
    throw new RangeError("averageOverlapSec must be a finite nonnegative number");
  }

  if (photoMaxSec < photoBaseSec) {
    throw new RangeError("photoMaxSec must be greater than or equal to photoBaseSec");
  }

  const effectiveSceneSec = photoBaseSec - averageOverlapSec;
  if (effectiveSceneSec <= 0) {
    throw new RangeError("averageOverlapSec must be less than photoBaseSec");
  }

  return {
    photoBaseSec,
    photoMaxSec,
    targetDurationSec,
    targetSceneCount: Math.max(1, Math.round(targetDurationSec / effectiveSceneSec)),
    videoMaxSec,
  };
};
