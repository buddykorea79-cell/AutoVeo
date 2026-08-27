import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {ffmpegPath, ffprobePath} from "ffmpeg-ffprobe-static";
import {afterEach, describe, expect, it} from "vitest";

import {FfmpegService} from "./ffmpeg.js";
import {FfprobeService} from "./ffprobe.js";
import {scanMusicLibrary} from "./music-library.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, {force: true, maxRetries: 5, recursive: true, retryDelay: 100})),
  );
});

describe("MusicLibrary ffprobe integration", () => {
  it("measures a real MP3 and ignores the declared duration", async () => {
    if (ffmpegPath === null || ffprobePath === null) {
      throw new Error("Bundled ffmpeg and ffprobe are required");
    }
    const root = await mkdtemp(path.join(tmpdir(), "travel-music-library-"));
    temporaryRoots.push(root);
    const musicRoot = path.join(root, "music");
    const calmRoot = path.join(musicRoot, "calm");
    const catalogPath = path.join(root, "tracks.json");
    const trackPath = path.join(calmRoot, "measured.mp3");
    await mkdir(calmRoot, {recursive: true});
    await new FfmpegService(ffmpegPath).run([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=1.25",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      trackPath,
    ]);
    await writeFile(
      catalogPath,
      JSON.stringify({
        schemaVersion: 2,
        tracks: [
          {
            attribution: "Integration Test",
            bpm: null,
            durationSec: 99,
            energy: 0.3,
            id: "measured",
            license: "Test fixture",
            mood: ["calm", "ambient"],
            path: "calm/measured.mp3",
            tags: [],
          },
        ],
      }),
    );

    const library = await scanMusicLibrary({
      catalogPath,
      musicRoot,
      probe: new FfprobeService(ffprobePath),
    });

    expect(library.tracks).toHaveLength(1);
    expect(library.tracks[0]!.durationSec).toBeGreaterThan(1.2);
    expect(library.tracks[0]!.durationSec).toBeLessThan(1.4);
    expect(library.warnings).toEqual([
      expect.objectContaining({code: "duration-mismatch", trackId: "measured"}),
    ]);
  }, 15_000);
});
