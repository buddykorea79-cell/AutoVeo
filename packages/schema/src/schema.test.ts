import {readFile} from "node:fs/promises";

import {describe, expect, it} from "vitest";

import {projectSchema} from "./project.js";
import {renderPlanSchema} from "./render-plan.js";
import {musicCatalogSchema, musicSelectionSchema} from "./music.js";
import {subtitleManifestSchema} from "./subtitle.js";

const readExample = async (filename: string): Promise<unknown> => {
  const url = new URL(`../../../examples/${filename}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as unknown;
};

describe("example documents", () => {
  it("validates project.json", async () => {
    expect(projectSchema.safeParse(await readExample("project.json")).success).toBe(true);
  });

  it("validates render-plan.json", async () => {
    expect(renderPlanSchema.safeParse(await readExample("render-plan.json")).success).toBe(true);
  });
});

describe("semantic and frame layers", () => {
  it("validates strict music catalog and selection documents", () => {
    expect(
      musicCatalogSchema.safeParse({
        schemaVersion: 2,
        tracks: [
          {
            attribution: "Example Artist",
            bpm: 96,
            energy: 0.4,
            id: "calm-example",
            license: "User supplied",
            mood: ["calm", "acoustic"],
            path: "calm/example.mp3",
            tags: ["travel"],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      musicSelectionSchema.safeParse({
        choices: [],
        mode: "none",
        schemaVersion: 2,
        totalDurationSec: 120,
        trackCountLimit: 1,
        warnings: [],
      }).success,
    ).toBe(true);
  });

  it("validates strict subtitle proposals and warnings", () => {
    expect(
      subtitleManifestSchema.safeParse({
        proposals: [
          {
            kind: "scene-caption",
            lines: ["직접 확인한 자막"],
            sceneId: "s_1",
            text: "직접 확인한 자막",
          },
        ],
        schemaVersion: 2,
        warnings: [],
      }).success,
    ).toBe(true);
    expect(
      subtitleManifestSchema.safeParse({
        proposals: [
          {
            extra: true,
            kind: "scene-caption",
            lines: ["직접 확인한 자막"],
            sceneId: "s_1",
            text: "직접 확인한 자막",
          },
        ],
        schemaVersion: 2,
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it("rejects frame fields in Project scenes", async () => {
    const project = (await readExample("project.json")) as {
      chapters: Array<{scenes: Array<Record<string, unknown>>}>;
    };
    const firstScene = project.chapters[0]?.scenes[0];
    expect(firstScene).toBeDefined();
    if (firstScene !== undefined) {
      firstScene.startFrame = 0;
    }

    expect(projectSchema.safeParse(project).success).toBe(false);
  });

  it("rejects broken cumulative frame arithmetic", async () => {
    const plan = (await readExample("render-plan.json")) as {
      scenes: Array<Record<string, unknown>>;
    };
    const secondScene = plan.scenes[1];
    expect(secondScene).toBeDefined();
    if (secondScene !== undefined) {
      secondScene.startFrame = 100;
    }

    expect(renderPlanSchema.safeParse(plan).success).toBe(false);
  });
});
