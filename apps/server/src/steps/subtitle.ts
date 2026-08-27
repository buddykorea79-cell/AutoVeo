import {createHash} from "node:crypto";

import {
  projectSchema,
  subtitleManifestSchema,
  type Project,
  type SubtitleManifest,
  type SubtitleProposal,
  type SubtitleWarning,
} from "@travel-movie/schema";
import {wrapKorean} from "@travel-movie/core";

import type {Step} from "../jobs/job-runner.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";

/** v4: 자막이 있는 클립은 모두 화면에 올린다. 60% 상한이 자막을 조용히 지우고 있었다. */
export const SUBTITLE_CODE_VERSION = 4;

export const projectDocumentKey = (projectId: string): string =>
  `manifests/${projectId}/project.json`;

export const subtitleManifestKey = (projectId: string): string =>
  `manifests/${projectId}/subtitles.json`;

export const loadProjectDocument = async (
  storage: StorageAdapter,
  projectId: string,
): Promise<Project> => {
  const key = projectDocumentKey(projectId);
  if (!(await storage.exists(key))) {
    throw new Error("먼저 스토리보드 초안을 만드세요.");
  }
  return projectSchema.parse(JSON.parse((await storage.read(key)).toString("utf8")));
};

const normalizedText = (text: string): string => text.trim().replace(/\s+/gu, " ");

const effectiveChapterCaption = (
  chapter: Project["chapters"][number],
): Project["chapters"][number]["caption"] => {
  if (chapter.caption !== null && normalizedText(chapter.caption.text).length > 0) {
    return chapter.caption;
  }
  // Auto migration: legacy scene captions become segment captions (first scene's caption)
  const fallback = chapter.scenes.find(
    (scene) => scene.caption !== null && normalizedText(scene.caption.text).length > 0,
  )?.caption;
  return fallback ?? null;
};

const toChapterProposal = (
  chapter: Project["chapters"][number],
  warnings: SubtitleWarning[],
): SubtitleProposal | null => {
  const caption = effectiveChapterCaption(chapter);
  if (caption === null || normalizedText(caption.text).length === 0) {
    return null;
  }
  const lines = wrapKorean(caption.text, 22);
  if (
    lines.some((line) => line.length > 22) ||
    normalizedText(lines.join(" ")) !== normalizedText(caption.text)
  ) {
    warnings.push({
      chapterId: chapter.id,
      code: "text-overflow",
      message: "22자씩 두 줄에 들어가지 않습니다. Timeline에서 문장을 직접 다듬으세요.",
      sceneId: null,
    });
  }
  return {
    chapterId: chapter.id,
    kind: caption.kind,
    lines,
    sceneId: null,
    text: caption.text,
  };
};

export const planSubtitles = (projectInput: Project): SubtitleManifest => {
  const project = projectSchema.parse(projectInput);
  const chapters = project.chapters;
  const warnings: SubtitleWarning[] = [];

  // 자막을 넣어 둔 클립은 빠짐없이 화면에 올린다.
  // 예전에는 전체의 60%만 남겨서, 자막을 써도 보이지 않는 클립이 생겼다.
  // 자막을 줄이고 싶으면 타임라인에서 그 클립의 자막을 지우면 된다.
  const proposals = chapters.flatMap((chapter) => {
    const proposal = toChapterProposal(chapter, warnings);
    return proposal === null ? [] : [proposal];
  });

  if (chapters.length > 0 && proposals.length === 0) {
    warnings.push({
      chapterId: null,
      code: "below-target-coverage",
      message: "자막이 하나도 없습니다. 타임라인에서 클립을 고르고 자막을 직접 써 넣으세요.",
      sceneId: null,
    });
  }

  return subtitleManifestSchema.parse({proposals, schemaVersion: 2, warnings});
};

export const subtitleStepInputHash = async (
  projectId: string,
  storage: StorageAdapter,
): Promise<string> => {
  const project = await loadProjectDocument(storage, projectId);
  return createHash("sha1")
    .update(JSON.stringify(project))
    .update(`|${String(SUBTITLE_CODE_VERSION)}`)
    .digest("hex");
};

export const createSubtitleStep = (projectId: string, storage: StorageAdapter): Step => ({
  codeVersion: SUBTITLE_CODE_VERSION,
  invalidates: ["timeline", "render", "finalize", "verify"],
  name: "subtitle",
  outputRef: () => subtitleManifestKey(projectId),
  run: async (context) => {
    context.report({message: "자막 길이와 줄바꿈을 확인하는 중", progress: 0.3});
    const project = await loadProjectDocument(storage, projectId);
    const manifest = planSubtitles(project);
    context.report({message: "자막 초안을 저장하는 중", progress: 0.8});
    const key = subtitleManifestKey(projectId);
    await storage.write(key, Buffer.from(JSON.stringify(manifest, null, 2)));
    context.report({message: "자막 초안 완성", progress: 1});
    return manifest;
  },
});
