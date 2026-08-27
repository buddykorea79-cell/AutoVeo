import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from "remotion";

import type {RenderScene} from "@travel-movie/schema";

export const TitleScene = ({scene}: {readonly scene: RenderScene}) => {
  const frame = useCurrentFrame();
  const {width} = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        background: "linear-gradient(135deg, #1b3150 0%, #416f78 52%, #d18a55 100%)",
        color: "#f7f5f2",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          fontSize: Math.round(width * 0.068),
          fontWeight: 720,
          letterSpacing: "-0.04em",
          opacity: interpolate(frame, [0, 18], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          translate: `0 ${String(
            interpolate(frame, [0, 24], [30, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          )}px`,
        }}
      >
        {scene.assetUrl}
      </div>
    </AbsoluteFill>
  );
};
