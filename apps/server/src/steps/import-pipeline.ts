import {createHash} from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import type {Step, StepContext} from "../jobs/job-runner.js";
import type {MediaProbe} from "../services/ffprobe.js";
import type {MediaTranscoder} from "../services/ffmpeg.js";
import {
  getWebProject,
  loadProjectMediaIndex,
  projectManifestKey,
  updateProjectScanStatistics,
} from "../services/web-projects.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";
import {FINGERPRINT_CODE_VERSION, fingerprintMedia} from "./fingerprint.js";
import {PREPARE_CODE_VERSION, prepareMedia} from "./prepare.js";
import {hashMediaFolderSnapshot, scanMediaFolder} from "./scan.js";

export type ImportStepName = "fingerprint" | "prepare" | "scan";

export interface ImportStepDependencies {
  readonly database: BetterSqlite3.Database;
  readonly probe: MediaProbe;
  readonly storage: StorageAdapter;
  readonly transcoder: MediaTranscoder;
}

const SCAN_CODE_VERSION = 5;

const reportLog =
  (context: StepContext, progress: () => number) =>
  (message: string): void =>
    context.report({message, progress: progress()});

export const importStepInputHash = async (
  projectId: string,
  stepName: ImportStepName,
  dependencies: ImportStepDependencies,
): Promise<string> => {
  const project = getWebProject(dependencies.database, projectId);
  if (project === null) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  if (stepName === "scan") {
    const snapshot = await hashMediaFolderSnapshot(project.folderPath, "all");
    return createHash("sha1")
      .update([snapshot, project.folderPath, project.utcOffsetMin, SCAN_CODE_VERSION].join("|"))
      .digest("hex");
  }

  const index = await loadProjectMediaIndex(dependencies.storage, projectId);
  if (index === null) {
    throw new Error("먼저 원본 스캔 단계를 완료하세요.");
  }
  if (stepName === "fingerprint" && index.items.some((item) => item.analysisKey === null)) {
    throw new Error("먼저 미리보기 생성 단계를 완료하세요.");
  }
  return createHash("sha1")
    .update(JSON.stringify(index))
    .update(`|${stepName === "prepare" ? PREPARE_CODE_VERSION : FINGERPRINT_CODE_VERSION}`)
    .digest("hex");
};

export const createImportStep = (
  projectId: string,
  stepName: ImportStepName,
  dependencies: ImportStepDependencies,
  force: boolean,
): Step => {
  const manifestKey = projectManifestKey(projectId);

  if (stepName === "scan") {
    return {
      codeVersion: SCAN_CODE_VERSION,
      invalidates: [
        "prepare",
        "fingerprint",
        "group-clips",
        "detect-video-segments",
        "extract-video-clips",
        "analyze-clips",
        "assemble",
        "timeline",
        "music",
        "render",
        "finalize",
      ],
      name: "scan",
      outputRef: () => manifestKey,
      run: async (context) => {
        const project = getWebProject(dependencies.database, projectId);
        if (project === null) {
          throw new Error(`Unknown project: ${projectId}`);
        }
        let currentProgress = 0;
        const result = await scanMediaFolder(project.folderPath, {
          database: dependencies.database,
          manifestKey,
          mediaFilter: "all",
          onLog: reportLog(context, () => currentProgress),
          onProgress: ({completed, progress, total}) => {
            currentProgress = progress;
            context.report({
              message: `원본 확인 ${String(completed)} / ${String(total)}`,
              progress,
            });
          },
          probe: dependencies.probe,
          projectUtcOffsetMin: project.utcOffsetMin,
          storage: dependencies.storage,
        });
        updateProjectScanStatistics(dependencies.database, projectId, {...result.statistics});
        return {manifestKey, statistics: result.statistics};
      },
    };
  }

  if (stepName === "prepare") {
    return {
      codeVersion: PREPARE_CODE_VERSION,
      invalidates: [
        "fingerprint",
        "group-clips",
        "detect-video-segments",
        "extract-video-clips",
        "analyze-clips",
        "assemble",
        "timeline",
        "music",
        "render",
        "finalize",
      ],
      name: "prepare",
      outputRef: () => manifestKey,
      run: async (context) => {
        const index = await loadProjectMediaIndex(dependencies.storage, projectId);
        if (index === null) {
          throw new Error("먼저 원본 스캔 단계를 완료하세요.");
        }
        let currentProgress = 0;
        const result = await prepareMedia(
          index,
          {force, signal: context.signal, stages: ["thumb", "analysis"]},
          {
            database: dependencies.database,
            manifestKey,
            onLog: reportLog(context, () => currentProgress),
            onProgress: ({completed, progress, stage, total}) => {
              currentProgress = progress;
              context.report({
                message: `${stage === "thumb" ? "미리보기" : "분석 파일"} ${String(completed)} / ${String(total)}`,
                progress,
              });
            },
            probe: dependencies.probe,
            storage: dependencies.storage,
            transcoder: dependencies.transcoder,
          },
        );
        return {manifestKey, statistics: result.statistics};
      },
    };
  }

  return {
    codeVersion: FINGERPRINT_CODE_VERSION,
    invalidates: [
      "group-clips",
      "detect-video-segments",
      "extract-video-clips",
      "analyze-clips",
      "assemble",
      "timeline",
      "render",
      "finalize",
    ],
    name: "fingerprint",
    outputRef: () => manifestKey,
    run: async (context) => {
      const index = await loadProjectMediaIndex(dependencies.storage, projectId);
      if (index === null) {
        throw new Error("먼저 미리보기 생성 단계를 완료하세요.");
      }
      let currentProgress = 0;
      const result = await fingerprintMedia(
        index,
        {force},
        {
          database: dependencies.database,
          manifestKey,
          onLog: reportLog(context, () => currentProgress),
          onProgress: ({completed, progress, total}) => {
            currentProgress = progress;
            context.report({
              message: `사진 품질 확인 ${String(completed)} / ${String(total)}`,
              progress,
            });
          },
          storage: dependencies.storage,
        },
      );
      return {manifestKey, statistics: result.statistics};
    },
  };
};
