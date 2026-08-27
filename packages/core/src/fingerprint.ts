export const dhashDistance = (left: string, right: string): number => {
  const hexPattern = /^[0-9a-f]+$/iu;

  if (left.length !== right.length || left.length === 0) {
    throw new Error("dHash values must have the same nonzero length");
  }

  if (!hexPattern.test(left) || !hexPattern.test(right)) {
    throw new Error("dHash values must be hexadecimal strings");
  }

  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;

  while (difference > 0n) {
    difference &= difference - 1n;
    distance += 1;
  }

  return distance;
};

export const dhashFromGrayscale = (pixels: Uint8Array, width = 9, height = 8): string => {
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 1) {
    throw new RangeError("dHash dimensions must be positive integers with width >= 2");
  }
  if (pixels.length !== width * height) {
    throw new RangeError(`Expected ${String(width * height)} grayscale pixels`);
  }

  let hash = 0n;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const left = pixels[y * width + x]!;
      const right = pixels[y * width + x + 1]!;
      hash = (hash << 1n) | (left < right ? 1n : 0n);
    }
  }

  const bitCount = (width - 1) * height;
  return hash.toString(16).padStart(Math.ceil(bitCount / 4), "0");
};

export const percentileRanks = (values: readonly number[]): number[] => {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError("Percentile inputs must be finite numbers");
  }
  if (values.length === 0) {
    return [];
  }
  if (values.length === 1) {
    return [1];
  }

  const sorted = values
    .map((value, index) => ({index, value}))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const result = new Array<number>(values.length);
  let cursor = 0;
  while (cursor < sorted.length) {
    let end = cursor + 1;
    while (end < sorted.length && sorted[end]!.value === sorted[cursor]!.value) {
      end += 1;
    }
    const averageRank = (cursor + end - 1) / 2 / (values.length - 1);
    for (let index = cursor; index < end; index += 1) {
      result[sorted[index]!.index] = averageRank;
    }
    cursor = end;
  }

  return result;
};

export interface HashTimeItem {
  readonly capturedAtLocal: string;
  readonly dhash: string;
  readonly id: string;
}

export interface ClusterOptions {
  readonly maxGapSec: number;
  readonly maxHamming: number;
}

const parseLocalTimestamp = (value: string): number => {
  const timestamp = Date.parse(`${value}Z`);

  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid capturedAtLocal value: ${value}`);
  }

  return timestamp;
};

export const clusterByTimeAndHash = <T extends HashTimeItem>(
  items: readonly T[],
  options: ClusterOptions,
): T[][] => {
  if (!Number.isFinite(options.maxGapSec) || options.maxGapSec < 0) {
    throw new RangeError("maxGapSec must be a finite nonnegative number");
  }

  if (!Number.isInteger(options.maxHamming) || options.maxHamming < 0) {
    throw new RangeError("maxHamming must be a nonnegative integer");
  }

  const sorted = [...items].sort((left, right) => {
    const byTime = left.capturedAtLocal.localeCompare(right.capturedAtLocal);
    return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
  });
  const clusters: T[][] = [];

  for (const item of sorted) {
    const current = clusters.at(-1);
    const previous = current?.at(-1);

    if (current === undefined || previous === undefined) {
      clusters.push([item]);
      continue;
    }

    const gapSec =
      (parseLocalTimestamp(item.capturedAtLocal) - parseLocalTimestamp(previous.capturedAtLocal)) /
      1000;
    const distance = dhashDistance(item.dhash, previous.dhash);

    if (gapSec <= options.maxGapSec && distance <= options.maxHamming) {
      current.push(item);
    } else {
      clusters.push([item]);
    }
  }

  return clusters;
};
