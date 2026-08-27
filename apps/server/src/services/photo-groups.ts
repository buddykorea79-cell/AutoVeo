import {createHash} from "node:crypto";

import {GROUP_CLIP_TIMING, type MediaItem, type PhotoGroup} from "@travel-movie/schema";

export const PHOTO_GROUP_CODE_VERSION = 1;

/** 같은 장면으로 볼 최대 촬영 간격. 이보다 벌어지면 다른 그룹으로 나눈다. */
const GROUP_GAP_MINUTES = 8;
const GROUP_MOVE_KM = 0.8;

const timeMs = (value: string): number => new Date(`${value}Z`).getTime();

const distanceKm = (left: MediaItem, right: MediaItem): number | null => {
  if (left.gps === null || right.gps === null) {
    return null;
  }
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const latDelta = radians(right.gps.lat - left.gps.lat);
  const lonDelta = radians(right.gps.lon - left.gps.lon);
  const haversine =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(radians(left.gps.lat)) *
      Math.cos(radians(right.gps.lat)) *
      Math.sin(lonDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

export const isGroupBoundary = (previous: MediaItem, current: MediaItem): boolean => {
  if (previous.capturedAtLocal.slice(0, 10) !== current.capturedAtLocal.slice(0, 10)) {
    return true;
  }
  const gapMinutes = (timeMs(current.capturedAtLocal) - timeMs(previous.capturedAtLocal)) / 60_000;
  if (!Number.isFinite(gapMinutes) || gapMinutes >= GROUP_GAP_MINUTES) {
    return true;
  }
  const moved = distanceKm(previous, current);
  return moved !== null && moved >= GROUP_MOVE_KM;
};

/** 그룹 만들기에 쓸 사진. 제외했거나 흔들린 컷, Live Photo 동영상 부분은 뺀다. */
export const eligiblePhotos = (items: readonly MediaItem[]): MediaItem[] =>
  items
    .filter(
      (item) =>
        item.mediaType === "photo" &&
        item.userDecision !== "exclude" &&
        item.livePhoto?.role !== "motion" &&
        (item.userDecision === "include" ||
          (item.isClusterBest && !item.issues.includes("blurry"))),
    )
    .toSorted((left, right) => left.capturedAtLocal.localeCompare(right.capturedAtLocal));

/** 영상은 그룹으로 묶지 않고 각자 하나의 소스로 다룬다. */
export const eligibleVideos = (items: readonly MediaItem[]): MediaItem[] =>
  items
    .filter((item) => item.mediaType === "video" && item.userDecision !== "exclude")
    .toSorted((left, right) => left.capturedAtLocal.localeCompare(right.capturedAtLocal));

export const groupTitle = (items: readonly MediaItem[], index: number): string => {
  const known = items.find(
    (item) =>
      item.place !== null &&
      item.place.city !== null &&
      (item.place.confidence === "city" || item.place.confidence === "exact"),
  )?.place;
  if (known?.city != null) {
    return known.area === null ? known.city : `${known.city} · ${known.area}`;
  }
  const time = items[0]!.capturedAtLocal.slice(11, 16);
  return `장면 ${String(index + 1)} · ${time}`;
};

export const buildPhotoGroups = (
  projectId: string,
  items: readonly MediaItem[],
): readonly PhotoGroup[] => {
  const photos = eligiblePhotos(items);
  const buckets: MediaItem[][] = [];
  for (const photo of photos) {
    const current = buckets.at(-1);
    const previous = current?.at(-1);
    if (
      current === undefined ||
      previous === undefined ||
      current.length >= GROUP_CLIP_TIMING.maxPhotosPerGroup ||
      isGroupBoundary(previous, photo)
    ) {
      buckets.push([photo]);
    } else {
      current.push(photo);
    }
  }
  return buckets.map((bucket, index) => buildGroup(projectId, bucket, index, "auto"));
};

/**
 * 사진 목록 하나를 그룹 한 개로 만든다.
 * 자동 묶기와 사람이 고친 그룹이 똑같은 규칙으로 id·제목·시간을 갖게 한다.
 */
export const buildGroup = (
  projectId: string,
  items: readonly MediaItem[],
  index: number,
  source: "auto" | "user",
): PhotoGroup => {
  if (items.length === 0) {
    throw new Error("그룹에는 사진이 최소 한 장 필요합니다.");
  }
  const ordered = items.toSorted((left, right) =>
    left.capturedAtLocal.localeCompare(right.capturedAtLocal),
  );
  return {
    clip: null,
    endAtLocal: ordered.at(-1)!.capturedAtLocal,
    id: `g_${createHash("sha1")
      .update(`${projectId}:${ordered.map((item) => item.relativePath).join("|")}`)
      .digest("hex")
      .slice(0, 10)}`,
    mediaIds: ordered.map((item) => item.id),
    source,
    startAtLocal: ordered[0]!.capturedAtLocal,
    style: "standard",
    title: groupTitle(ordered, index),
  };
};
