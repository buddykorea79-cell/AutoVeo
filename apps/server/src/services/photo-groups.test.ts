import {describe, expect, it} from "vitest";

import type {MediaItem} from "@travel-movie/schema";

import {buildPhotoGroups, eligiblePhotos, eligibleVideos} from "./photo-groups.js";

const photo = (index: number, capturedAtLocal: string, patch: Partial<MediaItem> = {}): MediaItem =>
  ({
    absolutePath: `C:/trip/p${String(index)}.jpg`,
    analysisKey: null,
    blurScore: 0.8,
    capturedAtLocal,
    clusterId: null,
    contentHash: `hash-${String(index)}`,
    dhash: null,
    exposureScore: 0.7,
    ext: ".jpg",
    filename: `p${String(index)}.jpg`,
    fileSize: 1000,
    gps: null,
    height: 3000,
    id: `m_${String(index)}`,
    isClusterBest: true,
    issues: [],
    livePhoto: null,
    mediaType: "photo",
    orientation: "landscape",
    place: null,
    proxyKey: null,
    relativePath: `p${String(index)}.jpg`,
    renderAssetKey: null,
    rotationApplied: true,
    status: "ok",
    thumbKey: null,
    timeSource: "exif-naive",
    userDecision: "auto",
    utcOffsetMin: 540,
    video: null,
    width: 4000,
    ...patch,
  }) as MediaItem;

describe("buildPhotoGroups", () => {
  it("keeps photos taken minutes apart in one group and caps the group size", () => {
    const items = Array.from({length: 7}, (_, index) =>
      photo(index, `2026-07-24T10:0${String(index)}:00`),
    );

    const groups = buildPhotoGroups("p1", items);

    expect(groups.map((group) => group.mediaIds.length)).toEqual([5, 2]);
    expect(groups[0]?.mediaIds).toEqual(["m_0", "m_1", "m_2", "m_3", "m_4"]);
  });

  it("splits on a long gap and on a date change", () => {
    const items = [
      photo(0, "2026-07-24T10:00:00"),
      photo(1, "2026-07-24T10:02:00"),
      photo(2, "2026-07-24T13:30:00"),
      photo(3, "2026-07-25T09:00:00"),
    ];

    const groups = buildPhotoGroups("p1", items);

    expect(groups.map((group) => group.mediaIds)).toEqual([["m_0", "m_1"], ["m_2"], ["m_3"]]);
  });

  it("splits when the camera moved far enough within the gap window", () => {
    const items = [
      photo(0, "2026-07-24T10:00:00", {gps: {alt: null, lat: 33.45, lon: 126.56}}),
      photo(1, "2026-07-24T10:03:00", {gps: {alt: null, lat: 33.5, lon: 126.56}}),
    ];

    expect(buildPhotoGroups("p1", items)).toHaveLength(2);
  });

  it("drops excluded, blurry, non-representative photos and Live Photo movies", () => {
    const items = [
      photo(0, "2026-07-24T10:00:00"),
      photo(1, "2026-07-24T10:01:00", {userDecision: "exclude"}),
      photo(2, "2026-07-24T10:02:00", {issues: ["blurry"]}),
      photo(3, "2026-07-24T10:03:00", {isClusterBest: false}),
      photo(4, "2026-07-24T10:04:00", {livePhoto: {pairId: "a", role: "motion"}}),
    ];

    expect(eligiblePhotos(items).map((item) => item.id)).toEqual(["m_0"]);
  });

  it("keeps a user-included photo even when it is blurry", () => {
    const items = [photo(0, "2026-07-24T10:00:00", {issues: ["blurry"], userDecision: "include"})];

    expect(eligiblePhotos(items)).toHaveLength(1);
  });

  it("returns videos separately and in capture order", () => {
    const items = [
      photo(0, "2026-07-24T10:05:00", {
        mediaType: "video",
        video: {
          audioCodec: "aac",
          bitrate: 1000,
          durationSec: 12,
          fps: 30,
          hasAudio: true,
          videoCodec: "hevc",
        },
      }),
      photo(1, "2026-07-24T10:00:00", {
        mediaType: "video",
        video: {
          audioCodec: null,
          bitrate: null,
          durationSec: 8,
          fps: 30,
          hasAudio: false,
          videoCodec: "h264",
        },
      }),
      photo(2, "2026-07-24T10:02:00"),
    ];

    expect(eligibleVideos(items).map((item) => item.id)).toEqual(["m_1", "m_0"]);
  });

  it("gives every group a stable id derived from its photos", () => {
    const items = [photo(0, "2026-07-24T10:00:00"), photo(1, "2026-07-24T10:01:00")];

    expect(buildPhotoGroups("p1", items)[0]?.id).toBe(buildPhotoGroups("p1", items)[0]?.id);
    expect(buildPhotoGroups("p1", items)[0]?.id).not.toBe(buildPhotoGroups("p2", items)[0]?.id);
  });
});
