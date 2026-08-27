import {Composition, staticFile, type CalculateMetadataFunction} from "remotion";

import {renderPlanSchema} from "@travel-movie/schema";

import {TravelMovie, type TravelMovieProps} from "./TravelMovie";

const calculateMetadata: CalculateMetadataFunction<TravelMovieProps> = async ({
  abortSignal,
  props,
}) => {
  const response = await fetch(staticFile(props.planPath.replace(/^\/+/, "")), {
    signal: abortSignal,
  });
  if (!response.ok) {
    throw new Error(`Could not load render plan: ${String(response.status)}`);
  }
  const plan = renderPlanSchema.parse(await response.json());
  if (plan.totalFrames <= 0) {
    throw new Error("Render plan must contain at least one frame");
  }
  return {
    durationInFrames: plan.totalFrames,
    fps: plan.fps,
    height: plan.height,
    width: plan.width,
  };
};

export const RemotionRoot = () => (
  <Composition
    id="TravelMovie"
    component={TravelMovie}
    durationInFrames={1}
    fps={30}
    width={1280}
    height={720}
    defaultProps={{planPath: "plans/demo-render-plan.json"}}
    calculateMetadata={calculateMetadata}
  />
);
