import {useEffect, useState} from "react";
import {AbsoluteFill, cancelRender, continueRender, delayRender, staticFile} from "remotion";

import {renderPlanSchema, type RenderPlan} from "@travel-movie/schema";

import {usePretendardFont} from "./fonts/load";
import {TimelineScene} from "./scenes/TimelineScene";

export type TravelMovieProps = {
  readonly planPath: string;
};

const useRenderPlan = (planPath: string): RenderPlan | null => {
  const [plan, setPlan] = useState<RenderPlan | null>(null);
  const [handle] = useState(() => delayRender("Loading render plan"));

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(staticFile(planPath.replace(/^\/+/, "")), {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Could not load render plan: ${String(response.status)}`);
        }
        setPlan(renderPlanSchema.parse(await response.json()));
        continueRender(handle);
      } catch (error) {
        if (!controller.signal.aborted) {
          cancelRender(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [handle, planPath]);

  return plan;
};

export const TravelMovie = ({planPath}: TravelMovieProps) => {
  usePretendardFont();
  const plan = useRenderPlan(planPath);

  if (plan === null) {
    return null;
  }

  return (
    <AbsoluteFill style={{backgroundColor: "#17191c", fontFamily: "PretendardVariable"}}>
      {plan.scenes.map((scene, index) => (
        <TimelineScene
          key={scene.id}
          index={index}
          nextScene={plan.scenes[index + 1] ?? null}
          scene={scene}
        />
      ))}
    </AbsoluteFill>
  );
};
