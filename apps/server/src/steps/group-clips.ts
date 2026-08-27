import {createHash} from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import {
  CLIP_STYLE_TIMING,
  GROUP_CLIP_TIMING,
  groupManifestSchema,
  type GroupManifest,
  type MediaIndex,
  type MediaItem,
  type PhotoGroup,
} from "@travel-movie/schema";

import type {Step, StepContext} from "../jobs/job-runner.js";
import type {ComfyService} from "../services/comfy.js";
import type {MediaProbe} from "../services/ffprobe.js";
import type {MediaTranscoder} from "../services/ffmpeg.js";
import {
  CLIP_COMPOSER_CODE_VERSION,
  composeClipThumbnail,
  composeGroupClip,
} from "../services/clip-composer.js";
import {
  GROUP_CLIP_REMOTION_CODE_VERSION,
  renderGroupClipWithRemotion,
} from "../services/group-clip-remotion.js";
import {buildPhotoGroups, PHOTO_GROUP_CODE_VERSION} from "../services/photo-groups.js";
import type {RemotionRenderService} from "../services/remotion.js";
import {
  outputDimensions,
  renderTargetLongEdgePx,
  type OutputAspect,
  type OutputResolution,
} from "../services/output-format.js";
import {loadProjectMediaIndex, projectManifestKey} from "../services/web-projects.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";
import {prepareMedia, PREPARE_CODE_VERSION} from "./prepare.js";

export const GROUP_CLIPS_CODE_VERSION = 1;

export interface GroupClipsParams {
  readonly aspect: OutputAspect;
  readonly fps: 24 | 30 | 60;
  readonly resolution: OutputResolution;
}

export interface GroupClipsDependencies {
  readonly comfy?: Pick<ComfyService, "generateClip">;
  readonly database: BetterSqlite3.Database;
  readonly probe: MediaProbe;
  /** 있으면 Remotion 으로 클립을 만든다. 없으면 ffmpeg 로 물러난다. */
  readonly renderer?: Pick<RemotionRenderService, "render">;
  readonly storage: StorageAdapter;
  readonly transcoder: MediaTranscoder;
}

export const groupManifestKey = (projectId: string): string => `manifests/${projectId}/groups.json`;

export const loadGroupManifest = async (
  storage: StorageAdapter,
  projectId: string,
): Promise<GroupManifest | null> => {
  const key = groupManifestKey(projectId);
  if (!(await storage.exists(key))) {
    return null;
  }
  return groupManifestSchema.parse(JSON.parse((await storage.read(key)).toString("utf8")));
};

export const saveGroupManifest = async (
  storage: StorageAdapter,
  manifest: GroupManifest,
): Promise<GroupManifest> => {
  const parsed = groupManifestSchema.parse(manifest);
  await storage.write(
    groupManifestKey(parsed.projectId),
    Buffer.from(JSON.stringify(parsed, null, 2)),
  );
  return parsed;
};

/**
 * 클립을 만들 그룹을 정한다.
 * 사람이 손으로 고친 적이 있으면(mode === "manual") 자동 묶기를 다시 하지 않는다.
 * 그 사이에 지워지거나 제외된 사진만 걸러 낸다.
 */
export const resolveGroups = async (
  projectId: string,
  index: MediaIndex,
  storage: StorageAdapter,
): Promise<readonly PhotoGroup[]> => {
  const manifest = await loadGroupManifest(storage, projectId);
  if (manifest === null || manifest.mode !== "manual") {
    return buildPhotoGroups(projectId, index.items);
  }
  const usable = new Set(
    index.items
      .filter((item) => item.mediaType === "photo" && item.userDecision !== "exclude")
      .map((item) => item.id),
  );
  return manifest.groups
    .map((group) => ({...group, mediaIds: group.mediaIds.filter((id) => usable.has(id))}))
    .filter((group) => group.mediaIds.length > 0);
};

const groupFingerprint = (
  group: PhotoGroup,
  items: readonly MediaItem[],
  params: GroupClipsParams,
): string =>
  createHash("sha1")
    .update(
      JSON.stringify({
        composer: CLIP_COMPOSER_CODE_VERSION,
        contentHashes: items.map((item) => item.contentHash),
        mediaIds: group.mediaIds,
        params,
        remotion: GROUP_CLIP_REMOTION_CODE_VERSION,
        // 스타일이 바뀐 그룹만 다시 만들도록 지문에 넣는다.
        style: group.style,
        styleTiming: CLIP_STYLE_TIMING[group.style],
        timing: GROUP_CLIP_TIMING,
      }),
    )
    .digest("hex");

export const groupClipsInputHash = async (
  projectId: string,
  dependencies: Pick<GroupClipsDependencies, "storage">,
  params: GroupClipsParams,
): Promise<string> => {
  const index = await loadProjectMediaIndex(dependencies.storage, projectId);
  if (index === null) {
    throw new Error("먼저 원본을 불러오세요.");
  }
  const groups = await resolveGroups(projectId, index, dependencies.storage);
  const byId = new Map(index.items.map((item) => [item.id, item]));
  return createHash("sha1")
    .update(
      JSON.stringify({
        groupVersion: PHOTO_GROUP_CODE_VERSION,
        groups: groups.map((group) =>
          groupFingerprint(
            group,
            group.mediaIds.map((mediaId) => byId.get(mediaId)!).filter(Boolean),
            params,
          ),
        ),
        prepare: PREPARE_CODE_VERSION,
        version: GROUP_CLIPS_CODE_VERSION,
      }),
    )
    .digest("hex");
};

const clipAssetKey = (projectId: string, groupId: string, fingerprint: string): string =>
  `clips/${projectId}/${groupId}-${fingerprint.slice(0, 8)}.mp4`;

const clipThumbKey = (projectId: string, groupId: string, fingerprint: string): string =>
  `clips/${projectId}/${groupId}-${fingerprint.slice(0, 8)}.webp`;

const generateWithComfy = async (
  comfy: Pick<ComfyService, "generateClip">,
  input: {
    readonly dimensions: {height: number; width: number};
    readonly fingerprint: string;
    readonly fps: number;
    readonly group: PhotoGroup;
    readonly projectId: string;
    readonly sourceBuffer: Buffer;
    readonly sourceFilename: string;
    readonly targetFrames: number;
  },
  signal?: AbortSignal,
): Promise<string> =>
  comfy.generateClip(
    {
      fps: input.fps,
      height: input.dimensions.height,
      inputHash: input.fingerprint,
      negativePrompt: "blurry, low quality, watermark, text, deformed",
      projectId: input.projectId,
      prompt: `cinematic travel footage, ${input.group.title}, natural camera movement, realistic lighting`,
      sceneId: `group_${input.group.id}`,
      seed: 0,
      sourceBuffer: input.sourceBuffer,
      sourceFilename: input.sourceFilename,
      targetFrames: input.targetFrames,
      width: input.dimensions.width,
    },
    signal,
  );

export const createGroupClipsStep = (
  projectId: string,
  params: GroupClipsParams,
  dependencies: GroupClipsDependencies,
  force: boolean,
  /** 지정하면 이 그룹만 다시 만들고 나머지는 기존 클립을 그대로 둔다. */
  forceGroupIds: readonly string[] = [],
): Step => ({
  codeVersion: GROUP_CLIPS_CODE_VERSION,
  invalidates: ["analyze-clips", "assemble", "timeline", "music", "render", "finalize"],
  name: "group-clips",
  outputRef: () => groupManifestKey(projectId),
  run: async (context: StepContext) => {
    const index = await loadProjectMediaIndex(dependencies.storage, projectId);
    if (index === null) {
      throw new Error("먼저 원본을 불러오세요.");
    }
    const groups = await resolveGroups(projectId, index, dependencies.storage);
    if (groups.length === 0) {
      throw new Error(
        "그룹으로 묶을 사진이 없습니다. 사진이 있는 폴더인지, 모두 제외하지 않았는지 확인하세요.",
      );
    }

    const groupMediaIds = [...new Set(groups.flatMap((group) => group.mediaIds))];
    context.report({message: "그룹 사진의 고화질 파일을 준비하는 중", progress: 0.04});
    const prepared = await prepareMedia(
      index,
      {
        force: false,
        mediaIds: groupMediaIds,
        renderTargetLongEdgePx: renderTargetLongEdgePx(params.resolution),
        signal: context.signal,
        stages: ["render"],
      },
      {
        database: dependencies.database,
        manifestKey: projectManifestKey(projectId),
        onProgress: ({completed, total}) =>
          context.report({
            message: `고화질 파일 ${String(completed)} / ${String(total)}`,
            progress: 0.04 + (total === 0 ? 0.26 : (completed / total) * 0.26),
          }),
        probe: dependencies.probe,
        storage: dependencies.storage,
        transcoder: dependencies.transcoder,
      },
    );

    const previous = await loadGroupManifest(dependencies.storage, projectId);
    const previousById = new Map((previous?.groups ?? []).map((group) => [group.id, group]));
    const dimensions = outputDimensions(params);
    const built: PhotoGroup[] = [];
    let done = 0;

    for (const group of groups) {
      if (context.signal.aborted) {
        throw new Error("클립 생성이 취소되었습니다.");
      }
      const items = group.mediaIds
        .map((mediaId) => prepared.index.items.find((item) => item.id === mediaId))
        .filter((item): item is MediaItem => item !== undefined);
      if (items.length === 0) {
        continue;
      }
      const fingerprint = groupFingerprint(group, items, params);
      const assetKey = clipAssetKey(projectId, group.id, fingerprint);
      const thumbKey = clipThumbKey(projectId, group.id, fingerprint);

      const cached = previousById.get(group.id)?.clip ?? null;
      // 특정 클립만 다시 만들라고 지정하면 그 그룹은 캐시를 건너뛴다.
      const forceThisGroup = force || forceGroupIds.includes(group.id);
      if (
        !forceThisGroup &&
        cached !== null &&
        cached.inputHash === fingerprint &&
        (await dependencies.storage.exists(cached.assetKey))
      ) {
        built.push({...group, clip: cached});
        done += 1;
        context.report({
          message: `클립 재사용 ${String(done)} / ${String(groups.length)}`,
          progress: 0.3 + (done / groups.length) * 0.7,
        });
        continue;
      }

      context.report({
        message: `클립 만드는 중 ${String(done + 1)} / ${String(groups.length)} — ${group.title}`,
        progress: 0.3 + (done / groups.length) * 0.7,
      });

      const photoPaths = await Promise.all(
        items.map(async (item) => {
          if (item.renderAssetKey === null) {
            throw new Error(`고화질 파일이 준비되지 않았습니다: ${item.filename}`);
          }
          return dependencies.storage.localPath(item.renderAssetKey);
        }),
      );

      let durationSec: number;
      let generator: "ffmpeg" | "comfy" | "remotion" = "ffmpeg";
      let generatedKey = assetKey;

      const styleTiming = CLIP_STYLE_TIMING[group.style];
      const composerInput = {
        crossfadeSec: styleTiming.crossfadeSec,
        fps: params.fps,
        height: dimensions.height,
        perPhotoSec: styleTiming.perPhotoSec,
        photoPaths,
        width: dimensions.width,
      };

      const composeWithFfmpeg = async (): Promise<number> => {
        const composed = await composeGroupClip(
          composerInput,
          assetKey,
          dependencies.storage,
          dependencies.transcoder,
          dependencies.probe,
          context.signal,
        );
        generatedKey = assetKey;
        generator = "ffmpeg";
        return composed.durationSec;
      };

      if (dependencies.renderer !== undefined) {
        // Remotion 은 회전·대각선 이동까지 표현할 수 있어 스타일 차이가 분명하게 드러난다.
        try {
          const rendered = await renderGroupClipWithRemotion(
            {
              fps: params.fps,
              height: dimensions.height,
              outputKey: assetKey,
              photoKeys: items.map((item) => item.renderAssetKey!),
              planKey: `plans/${projectId}/group-${group.id}.json`,
              style: group.style,
              width: dimensions.width,
            },
            dependencies.storage,
            dependencies.renderer,
            context.signal,
          );
          durationSec = rendered.durationSec;
          generatedKey = rendered.outputKey;
          generator = "remotion";
        } catch (error) {
          context.report({
            message: `Remotion 생성 실패로 기본 방식으로 만드는 중 — ${
              error instanceof Error ? error.message : String(error)
            }`,
            progress: 0.3 + (done / groups.length) * 0.7,
          });
          durationSec = await composeWithFfmpeg();
        }
      } else if (dependencies.comfy !== undefined) {
        try {
          const targetFrames = Math.max(
            2,
            Math.round(
              (items.length * styleTiming.perPhotoSec -
                (items.length - 1) * styleTiming.crossfadeSec) *
                params.fps,
            ),
          );
          generatedKey = await generateWithComfy(
            dependencies.comfy,
            {
              dimensions,
              fingerprint,
              fps: params.fps,
              group,
              projectId,
              sourceBuffer: await dependencies.storage.read(items[0]!.renderAssetKey!),
              sourceFilename: items[0]!.renderAssetKey!,
              targetFrames,
            },
            context.signal,
          );
          durationSec = targetFrames / params.fps;
          generator = "comfy";
        } catch (error) {
          context.report({
            message: `ComfyUI 생성 실패로 기본 방식으로 만드는 중 — ${
              error instanceof Error ? error.message : String(error)
            }`,
            progress: 0.3 + (done / groups.length) * 0.7,
          });
          durationSec = await composeWithFfmpeg();
        }
      } else {
        durationSec = await composeWithFfmpeg();
      }

      // 생성한 클립은 이 단계의 최종 산출물이다.
      // trackPartialOutput 으로 등록하면 단계가 끝날 때 지워지므로 등록하지 않는다.
      let resolvedThumb: string | null;
      try {
        resolvedThumb = await composeClipThumbnail(
          await dependencies.storage.localPath(generatedKey),
          durationSec * 0.35,
          thumbKey,
          dependencies.storage,
          dependencies.transcoder,
          context.signal,
        );
      } catch {
        resolvedThumb = null;
      }

      built.push({
        ...group,
        clip: {
          assetKey: generatedKey,
          createdAt: new Date().toISOString(),
          durationSec,
          generator,
          inputHash: fingerprint,
          style: group.style,
          thumbKey: resolvedThumb,
        },
      });
      done += 1;
      context.report({
        message: `클립 완성 ${String(done)} / ${String(groups.length)}`,
        progress: 0.3 + (done / groups.length) * 0.7,
      });
    }

    const manifest = await saveGroupManifest(dependencies.storage, {
      createdAt: new Date().toISOString(),
      groups: built,
      // 사람이 고친 구성은 클립을 만든 뒤에도 그대로 남는다.
      mode: built.some((group) => group.source === "user") ? "manual" : "auto",
      projectId,
      schemaVersion: 2,
    } satisfies GroupManifest);
    context.report({message: "그룹 클립 준비 완료", progress: 1});
    return {groups: manifest.groups.length};
  },
});
