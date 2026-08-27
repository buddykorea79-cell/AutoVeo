import {AbsoluteFill, Img, interpolate, Sequence, staticFile, useCurrentFrame} from "remotion";

import type {RenderMontageItem, RenderScene} from "@travel-movie/schema";

const MontageImage = ({
  index,
  item,
}: {
  readonly index: number;
  readonly item: RenderMontageItem;
}) => {
  const frame = useCurrentFrame();
  const endFrame = Math.max(1, item.durationInFrames - 1);
  const incoming =
    item.fadeInFrames === 0
      ? 1
      : interpolate(frame, [0, item.fadeInFrames], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  const outgoing =
    item.fadeOutFrames === 0
      ? 1
      : interpolate(frame, [item.durationInFrames - item.fadeOutFrames, endFrame], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  const scale = interpolate(frame, [0, endFrame], index % 2 === 0 ? [1.02, 1.09] : [1.09, 1.02], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{opacity: Math.min(incoming, outgoing), overflow: "hidden"}}>
      <Img
        src={staticFile(item.assetKey)}
        style={{
          height: "100%",
          objectFit: "cover",
          transform: `scale(${String(scale)})`,
          transformOrigin: "center center",
          width: "100%",
        }}
      />
    </AbsoluteFill>
  );
};

export const MontageScene = ({scene}: {readonly scene: RenderScene}) => {
  if (scene.montage === null) {
    throw new Error(`Montage scene ${scene.id} requires montage data`);
  }
  return (
    <AbsoluteFill>
      {scene.montage.items.map((item, index) => (
        <Sequence
          durationInFrames={item.durationInFrames}
          from={item.startFrame}
          key={item.mediaId}
          layout="absolute-fill"
          name={`${scene.id}:${item.mediaId}`}
        >
          <MontageImage index={index} item={item} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
