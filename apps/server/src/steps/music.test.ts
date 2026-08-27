import {describe, expect, it} from "vitest";

import type {MusicTrack} from "@travel-movie/schema";

import {RuleBasedMusicSelector} from "./music.js";

const track = (patch: Partial<MusicTrack> & Pick<MusicTrack, "id">): MusicTrack => ({
  attribution: "Test",
  bpm: null,
  durationSec: 240,
  energy: 0.5,
  license: "Test fixture",
  mood: ["cinematic"],
  path: `${patch.id}.mp3`,
  tags: [],
  ...patch,
});

describe("RuleBasedMusicSelector", () => {
  it("uses the documented mood, energy, and duration weights", async () => {
    const logs: unknown[] = [];
    const selector = new RuleBasedMusicSelector(
      [
        track({energy: 0.35, id: "calm-fit", mood: ["calm", "acoustic"]}),
        track({durationSec: 60, energy: 0.9, id: "short-upbeat", mood: ["upbeat"]}),
      ],
      (entry) => logs.push(entry),
    );

    const result = await selector.select(
      {energy: 0.4, mood: "calm"},
      {excludeTrackIds: [], minDurationSec: 180},
    );

    expect(result?.track.id).toBe("calm-fit");
    expect(result?.candidates[0]).toMatchObject({
      durationMatch: 1,
      moodMatch: 1,
      trackId: "calm-fit",
    });
    expect(logs).toHaveLength(1);
  });

  it("honors excluded track ids", async () => {
    const selector = new RuleBasedMusicSelector(
      [track({id: "first", mood: ["ambient"]}), track({id: "second", mood: ["ambient"]})],
      () => undefined,
    );
    const result = await selector.select(
      {energy: 0.5, mood: "night"},
      {excludeTrackIds: ["first"], minDurationSec: 10},
    );
    expect(result?.track.id).toBe("second");
  });
});
