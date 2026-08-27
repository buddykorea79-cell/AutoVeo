import {AbsoluteFill} from "remotion";

import type {RenderScene} from "@travel-movie/schema";

export const ColorScene = ({scene}: {readonly scene: RenderScene}) => (
  <AbsoluteFill style={{backgroundColor: scene.assetUrl}} />
);
