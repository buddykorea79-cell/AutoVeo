export type OutputAspect = "16:9" | "9:16" | "1:1";
export type OutputResolution = "720p" | "1080p" | "4k";

export interface OutputDimensions {
  readonly height: number;
  readonly width: number;
}

const longEdgeFor = (resolution: OutputResolution): number =>
  resolution === "4k" ? 3840 : resolution === "1080p" ? 1920 : 1280;

const shortEdgeFor = (resolution: OutputResolution): number =>
  resolution === "4k" ? 2160 : resolution === "1080p" ? 1080 : 720;

/** 화면 비율과 해상도 프리셋을 실제 픽셀 크기로 바꾼다. 짝수 픽셀만 나온다. */
export const outputDimensions = (output: {
  readonly aspect: OutputAspect;
  readonly resolution: OutputResolution;
}): OutputDimensions => {
  const longEdge = longEdgeFor(output.resolution);
  const shortEdge = shortEdgeFor(output.resolution);
  if (output.aspect === "9:16") {
    return {height: longEdge, width: shortEdge};
  }
  if (output.aspect === "1:1") {
    return {height: shortEdge, width: shortEdge};
  }
  return {height: shortEdge, width: longEdge};
};

export const renderTargetLongEdgePx = (resolution: OutputResolution): number =>
  longEdgeFor(resolution);
