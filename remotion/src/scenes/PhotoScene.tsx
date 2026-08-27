import {AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame} from "remotion";

import type {RenderScene} from "@travel-movie/schema";

export const PhotoScene = ({scene}: {readonly scene: RenderScene}) => {
  const frame = useCurrentFrame();
  if (scene.assetKey === null || scene.motion === null) {
    throw new Error(`Photo scene ${scene.id} requires render asset and motion data`);
  }
  const endFrame = Math.max(1, scene.durationInFrames - 1);
  const scale = interpolate(frame, [0, endFrame], [scene.motion.fromScale, scene.motion.toScale], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const x = interpolate(frame, [0, endFrame], [scene.motion.fromX, scene.motion.toX], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame, [0, endFrame], [scene.motion.fromY, scene.motion.toY], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rotate = interpolate(
    frame,
    [0, endFrame],
    [scene.motion.fromRotateDeg, scene.motion.toRotateDeg],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp"},
  );

  return (
    <AbsoluteFill style={{overflow: "hidden"}}>
      <Img
        src={staticFile(scene.assetKey)}
        style={{
          height: "100%",
          objectFit: "cover",
          transform: [
            `translate3d(${String(x * 100)}%, ${String(y * 100)}%, 0)`,
            `rotate(${rotate.toFixed(3)}deg)`,
            `scale(${String(scale)})`,
          ].join(" "),
          transformOrigin: "center center",
          width: "100%",
        }}
      />
    </AbsoluteFill>
  );
};
