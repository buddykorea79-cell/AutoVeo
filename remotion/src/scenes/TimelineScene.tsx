import {AbsoluteFill, interpolate, Sequence, useCurrentFrame} from "remotion";

import {lookCssFilter, type RenderScene} from "@travel-movie/schema";

import {CaptionLayer} from "../captions/CaptionLayer";
import {ColorScene} from "./ColorScene";
import {PhotoScene} from "./PhotoScene";
import {MontageScene} from "./MontageScene";
import {TitleScene} from "./TitleScene";
import {VideoScene} from "./VideoScene";

const SceneContents = ({scene}: {readonly scene: RenderScene}) => {
  if (scene.type === "photo") {
    return <PhotoScene scene={scene} />;
  }
  if (scene.type === "video") {
    return <VideoScene scene={scene} />;
  }
  if (scene.type === "montage") {
    return <MontageScene scene={scene} />;
  }
  if (scene.type === "title") {
    return <TitleScene scene={scene} />;
  }
  return <ColorScene scene={scene} />;
};

const SceneOpacity = ({
  nextScene,
  scene,
}: {
  readonly nextScene: RenderScene | null;
  readonly scene: RenderScene;
}) => {
  const frame = useCurrentFrame();
  const fadeInFrames = scene.transitionIn.type === "cut" ? 0 : scene.transitionIn.overlapFrames;
  const fadeOutFrames =
    nextScene === null || nextScene.transitionIn.type === "cut"
      ? 0
      : nextScene.transitionIn.overlapFrames;
  const incoming =
    fadeInFrames === 0
      ? 1
      : interpolate(frame, [0, fadeInFrames], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  const outgoing =
    fadeOutFrames === 0
      ? 1
      : interpolate(
          frame,
          [scene.durationInFrames - fadeOutFrames, scene.durationInFrames - 1],
          [1, 0],
          {extrapolateLeft: "clamp", extrapolateRight: "clamp"},
        );

  return (
    <AbsoluteFill style={{opacity: Math.min(incoming, outgoing)}}>
      {/* 색감 필터는 영상에만 걸고 자막은 원래 색으로 남긴다. */}
      <AbsoluteFill style={{filter: lookCssFilter(scene.look)}}>
        <SceneContents scene={scene} />
      </AbsoluteFill>
      <CaptionLayer scene={scene} />
    </AbsoluteFill>
  );
};

export const TimelineScene = ({
  index,
  nextScene,
  scene,
}: {
  readonly index: number;
  readonly nextScene: RenderScene | null;
  readonly scene: RenderScene;
}) => (
  <Sequence
    from={scene.startFrame}
    durationInFrames={scene.durationInFrames}
    layout="absolute-fill"
    name={scene.id}
  >
    <AbsoluteFill style={{zIndex: index}}>
      <SceneOpacity nextScene={nextScene} scene={scene} />
    </AbsoluteFill>
  </Sequence>
);
