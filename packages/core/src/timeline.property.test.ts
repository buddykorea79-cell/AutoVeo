import fc from "fast-check";
import {describe, expect, it} from "vitest";

import {layoutScenes, type PlannedScene} from "./timeline.js";

const PROPERTY_RUNS = 1_200;

const sceneArbitrary = fc.record({
  durationSec: fc.double({min: 0, max: 20, noNaN: true, noDefaultInfinity: true}),
  id: fc.uuid(),
  transitionIn: fc.record({
    durationSec: fc.double({min: 0, max: 3, noNaN: true, noDefaultInfinity: true}),
    type: fc.constantFrom("cut", "fade", "crossfade") as fc.Arbitrary<
      PlannedScene["transitionIn"]["type"]
    >,
  }),
});

const assertLayoutInvariants = (input: readonly PlannedScene[], fps: number): void => {
  const result = layoutScenes(input, fps);

  result.scenes.forEach((scene, index) => {
    expect(scene.durationInFrames).toBeGreaterThan(0);
    expect(scene.visibleFrames).toBeGreaterThan(0);

    const next = result.scenes[index + 1];
    if (next !== undefined) {
      expect(next.startFrame).toBe(
        scene.startFrame + scene.durationInFrames - next.transitionIn.overlapFrames,
      );
    }
  });

  const last = result.scenes.at(-1);
  expect(result.totalFrames).toBe(last === undefined ? 0 : last.startFrame + last.durationInFrames);
};

describe("layoutScenes properties", () => {
  it("preserves cumulative-frame invariants across arbitrary inputs", () => {
    console.info(`PROPERTY_TEST layoutScenes runs=${PROPERTY_RUNS} maxScenes=1000`);

    fc.assert(
      fc.property(
        fc.array(sceneArbitrary, {maxLength: 1_000}),
        fc.constantFrom(24, 30, 60),
        (scenes, fps) => {
          assertLayoutInvariants(scenes, fps);
        },
      ),
      {numRuns: PROPERTY_RUNS},
    );
  });

  it("lays out an explicit 1000-scene timeline", () => {
    const scenes: PlannedScene[] = Array.from({length: 1_000}, (_, index) => ({
      durationSec: 1.5 + (index % 17) / 10,
      id: `scene-${index}`,
      transitionIn: {
        durationSec: index % 3 === 0 ? 0 : (index % 9) / 10,
        type: index % 3 === 0 ? "cut" : index % 2 === 0 ? "fade" : "crossfade",
      },
    }));

    assertLayoutInvariants(scenes, 30);
  });
});
