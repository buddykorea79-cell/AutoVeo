import {readFile} from "node:fs/promises";

import {bundle} from "@remotion/bundler";
import {makeCancelSignal, renderMedia, selectComposition} from "@remotion/renderer";

import type {RemotionWorkerMessage, RemotionWorkerRequest} from "./remotion-worker-protocol.js";

const emitProgress = (progress: number): void => {
  const message: RemotionWorkerMessage = {progress, type: "progress"};
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const run = async (): Promise<void> => {
  const requestPath = process.argv[2];
  if (requestPath === undefined) {
    throw new Error("Remotion worker requires a request JSON path");
  }
  const request = JSON.parse(await readFile(requestPath, "utf8")) as RemotionWorkerRequest;
  const {cancel, cancelSignal} = makeCancelSignal();
  process.once("SIGTERM", () => {
    cancel();
    setTimeout(() => process.exit(143), 5_000).unref();
  });
  const serveUrl = await bundle({
    enableCaching: true,
    entryPoint: request.entryPoint,
    onProgress: (progress) => emitProgress((progress / 100) * 0.1),
    outDir: `${request.workDirectory}/bundle`,
    publicDir: request.publicDir,
    // 폴더 심볼릭 링크는 Windows 에서 EPERM 이 난다. public 폴더는 이미 필요한 파일만 담고 있다.
    symlinkPublicDir: false,
  });
  const inputProps = {planPath: request.planPath};
  const composition = await selectComposition({
    ...(request.browserExecutable === null ? {} : {browserExecutable: request.browserExecutable}),
    chromiumOptions: {gl: "angle", headless: true},
    id: request.compositionId,
    inputProps,
    logLevel: "warn",
    serveUrl,
  });
  await renderMedia({
    ...(request.browserExecutable === null ? {} : {browserExecutable: request.browserExecutable}),
    audioCodec: null,
    cancelSignal,
    chromiumOptions: {gl: "angle", headless: true},
    codec: "h264",
    composition,
    concurrency: request.concurrency,
    enforceAudioTrack: false,
    inputProps,
    logLevel: "warn",
    muted: true,
    onProgress: ({progress}) => emitProgress(0.1 + progress * 0.9),
    outputLocation: request.outputLocation,
    overwrite: true,
    serveUrl,
  });
  emitProgress(1);
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
