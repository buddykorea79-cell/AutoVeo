import {AbsoluteFill, OffthreadVideo, staticFile} from "remotion";

import type {RenderScene} from "@travel-movie/schema";

export const VideoScene = ({scene}: {readonly scene: RenderScene}) => {
  if (scene.assetKey === null) {
    throw new Error(`Video scene ${scene.id} requires a proxy asset`);
  }
  return (
    <AbsoluteFill style={{backgroundColor: "#111"}}>
      <OffthreadVideo
        src={staticFile(scene.assetKey)}
        muted
        trimBefore={scene.trimStartFrame ?? 0}
        style={{height: "100%", objectFit: "cover", width: "100%"}}
      />
    </AbsoluteFill>
  );
};
