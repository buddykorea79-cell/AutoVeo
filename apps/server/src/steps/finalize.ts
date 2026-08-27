import {createHash, randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {access, mkdir, mkdtemp, readFile, rename, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import sharp from "sharp";

import {
  renderPlanSchema,
  verifyReportSchema,
  type AudioTrack,
  type RenderPlan,
  type VerifyCheck,
  type VerifyReport,
} from "@travel-movie/schema";

import {audioCrossfadeFrames, framesFromSeconds, secondsFromFrames} from "@travel-movie/core";

import type {Step} from "../jobs/job-runner.js";
import type {MediaTranscoder} from "../services/ffmpeg.js";
import type {MediaProbe} from "../services/ffprobe.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";
import {intermediateVideoKey, renderStepInputHash} from "./render.js";
import {renderPlanKey} from "./timeline.js";

export const FINALIZE_CODE_VERSION = 1;
const LOUDNESS_TARGET = -16;
const TRUE_PEAK_TARGET = -1.5;
const LOUDNESS_RANGE_TARGET = 11;

export interface FinalizeStepDependencies {
  readonly finalizer: FinalVideoService;
  readonly storage: StorageAdapter;
}

export interface FinalizeStepOutput {
  readonly hasAudio: boolean;
  readonly outputPath: string;
  readonly reportKey: string;
  readonly size: number;
  readonly status: "pass";
}

export interface FinalVideoFinalizerDependencies {
  readonly ffmpegPath: string;
  readonly outputRoot: string;
  readonly probe: MediaProbe;
  readonly storage: StorageAdapter;
  readonly transcoder: MediaTranscoder;
}

export interface FinalizeVideoOptions {
  readonly onProgress?: (progress: number, message: string) => void;
  readonly projectId: string;
  readonly signal?: AbortSignal;
  readonly title: string;
}

export interface FinalVideoService {
  finalize(
    inputPlan: RenderPlan,
    intermediatePath: string,
    options: FinalizeVideoOptions,
  ): Promise<FinalizeStepOutput>;
  outputPath(projectId: string): string;
  reportKey(projectId: string): string;
}

interface CaptureOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface LoudnormMeasurement {
  readonly inputI: number;
  readonly inputLra: number;
  readonly inputThreshold: number;
  readonly inputTp: number;
  readonly targetOffset: number;
}

interface AudioMix {
  readonly expectedAudio: boolean;
  readonly filterGraph: string;
  readonly inputArgs: string[];
  readonly outputLabel: string;
  readonly warnings: string[];
}

interface BgmFilterResult {
  readonly filterGraph: string;
  readonly outputLabel: string;
}

const seconds = (frames: number, fps: number): string => (frames / fps).toFixed(6);
const decibels = (value: number): string => `${value.toFixed(3)}dB`;

const runCaptured = async (
  binary: string,
  args: readonly string[],
  options: CaptureOptions = {},
): Promise<string> => {
  if (options.signal?.aborted === true) {
    throw options.signal.reason ?? new Error("FFmpeg operation was aborted");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      child.kill();
      finish(() => reject(options.signal?.reason ?? new Error("FFmpeg operation was aborted")));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`FFmpeg timed out after ${String(timeoutMs)}ms`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) =>
      finish(() => {
        const output = `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`;
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`FFmpeg exited with ${String(code)}: ${output.trim()}`));
        }
      }),
    );
    options.signal?.addEventListener("abort", abort, {once: true});
  });
};

const parseLoudnorm = (output: string): LoudnormMeasurement => {
  const matches = [...output.matchAll(/\{\s*"input_i"[\s\S]*?\}/gu)];
  const raw = matches.at(-1)?.[0];
  if (raw === undefined) {
    throw new Error("FFmpeg loudnorm 측정 JSON을 찾지 못했습니다.");
  }
  const parsed = JSON.parse(raw) as Record<string, string>;
  const values = {
    inputI: Number(parsed.input_i),
    inputLra: Number(parsed.input_lra),
    inputThreshold: Number(parsed.input_thresh),
    inputTp: Number(parsed.input_tp),
    targetOffset: Number(parsed.target_offset),
  };
  if (Object.values(values).some((value) => !Number.isFinite(value))) {
    throw new Error("오디오 라우드니스 측정값이 유효하지 않습니다.");
  }
  return values;
};

const firstPassFilter =
  `loudnorm=I=${String(LOUDNESS_TARGET)}:TP=${String(TRUE_PEAK_TARGET)}` +
  `:LRA=${String(LOUDNESS_RANGE_TARGET)}:print_format=json`;

const secondPassFilter = (measurement: LoudnormMeasurement): string =>
  `loudnorm=I=${String(LOUDNESS_TARGET)}:TP=${String(TRUE_PEAK_TARGET)}` +
  `:LRA=${String(LOUDNESS_RANGE_TARGET)}` +
  `:measured_I=${measurement.inputI.toFixed(3)}` +
  `:measured_TP=${measurement.inputTp.toFixed(3)}` +
  `:measured_LRA=${measurement.inputLra.toFixed(3)}` +
  `:measured_thresh=${measurement.inputThreshold.toFixed(3)}` +
  `:offset=${measurement.targetOffset.toFixed(3)}:linear=true:print_format=summary`;

const crossfadeFrames = (left: AudioTrack, right: AudioTrack, fps: number): number =>
  audioCrossfadeFrames(left, right, fps);

export const buildBgmFilterGraph = (
  inputTracks: readonly AudioTrack[],
  fps: number,
  firstInputIndex = 1,
): BgmFilterResult => {
  const tracks = [...inputTracks].sort((left, right) => left.startFrame - right.startFrame);
  if (tracks.length === 0) {
    throw new Error("BGM 필터를 만들려면 음악 트랙이 필요합니다.");
  }
  for (let index = 0; index < tracks.length - 1; index += 1) {
    const current = tracks[index]!;
    const next = tracks[index + 1]!;
    if (current.startFrame + current.durationInFrames !== next.startFrame) {
      throw new Error("음악 트랙은 빈 구간 없이 프레임 경계에서 이어져야 합니다.");
    }
  }
  const joins = tracks
    .slice(0, -1)
    .map((track, index) => crossfadeFrames(track, tracks[index + 1]!, fps));
  const filters: string[] = [];
  tracks.forEach((track, index) => {
    const extraFrames = joins[index] ?? 0;
    const durationSec = seconds(track.durationInFrames + extraFrames, fps);
    const chain = [
      `[${String(firstInputIndex + index)}:a:0]atrim=start=${track.sourceOffsetSec.toFixed(6)}:duration=${durationSec}`,
      "asetpts=PTS-STARTPTS",
      "aformat=sample_rates=48000:channel_layouts=stereo",
      `volume=${decibels(track.volumeDb)}`,
    ];
    for (const range of track.duckRanges) {
      const localStart = Math.max(0, range.startFrame - track.startFrame);
      const localEnd = Math.min(
        track.durationInFrames + extraFrames,
        localStart + range.durationInFrames,
      );
      if (localEnd > localStart) {
        chain.push(
          `volume=${decibels(range.gainDb)}:enable='between(t\\,${seconds(localStart, fps)}\\,${seconds(localEnd, fps)})'`,
        );
      }
    }
    if (index === 0 && track.fadeInFrames > 0) {
      chain.push(`afade=t=in:st=0:d=${seconds(track.fadeInFrames, fps)}`);
    }
    if (index === tracks.length - 1 && track.fadeOutFrames > 0) {
      const fadeStart = Math.max(0, track.durationInFrames - track.fadeOutFrames);
      chain.push(
        `afade=t=out:st=${seconds(fadeStart, fps)}:d=${seconds(track.fadeOutFrames, fps)}`,
      );
    }
    filters.push(`${chain.join(",")}[bgm${String(index)}]`);
  });

  let currentLabel = "bgm0";
  for (let index = 1; index < tracks.length; index += 1) {
    const outputLabel = `bgmJoin${String(index)}`;
    const duration = seconds(joins[index - 1]!, fps);
    filters.push(
      joins[index - 1] === 0
        ? `[${currentLabel}][bgm${String(index)}]concat=n=2:v=0:a=1[${outputLabel}]`
        : `[${currentLabel}][bgm${String(index)}]acrossfade=d=${duration}:c1=tri:c2=tri[${outputLabel}]`,
    );
    currentLabel = outputLabel;
  }
  const delayMs = Math.round(secondsFromFrames(tracks[0]!.startFrame, fps) * 1000);
  filters.push(`[${currentLabel}]adelay=delays=${String(delayMs)}:all=1[bgmDelayed]`);
  return {filterGraph: filters.join(";"), outputLabel: "bgmDelayed"};
};

const buildAudioMix = async (
  plan: RenderPlan,
  dependencies: Pick<FinalVideoFinalizerDependencies, "probe" | "storage">,
): Promise<AudioMix> => {
  const inputArgs: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];
  const warnings: string[] = [];
  let inputIndex = 1;

  if (plan.audio.length > 0) {
    for (const track of plan.audio) {
      await access(track.sourcePath);
      inputArgs.push("-stream_loop", "-1", "-i", track.sourcePath);
    }
    const bgm = buildBgmFilterGraph(plan.audio, plan.fps, inputIndex);
    filters.push(bgm.filterGraph);
    labels.push(bgm.outputLabel);
    inputIndex += plan.audio.length;
  }

  for (const scene of plan.scenes) {
    if (scene.type !== "video" || scene.sourceAudio === "mute" || scene.assetKey === null) {
      continue;
    }
    const sourcePath = await dependencies.storage.localPath(scene.assetKey);
    const metadata = await dependencies.probe.probe(sourcePath);
    if (!metadata.streams?.some((stream) => stream.codec_type === "audio")) {
      warnings.push(`${scene.id}: 원본 영상에 합칠 수 있는 오디오 스트림이 없습니다.`);
      continue;
    }
    inputArgs.push("-i", sourcePath);
    const durationFrames = scene.durationInFrames;
    const trimStartFrames = scene.trimStartFrame ?? 0;
    const fadeFrames = Math.min(framesFromSeconds(0.1, plan.fps), Math.floor(durationFrames / 4));
    const fadeOutStart = Math.max(0, durationFrames - fadeFrames);
    const sourceLabel = `source${String(inputIndex)}`;
    const sourceVolume = scene.sourceAudio === "duck" ? 0 : -6;
    filters.push(
      `[${String(inputIndex)}:a:0]` +
        `atrim=start=${seconds(trimStartFrames, plan.fps)}:duration=${seconds(durationFrames, plan.fps)},` +
        "asetpts=PTS-STARTPTS," +
        "aformat=sample_rates=48000:channel_layouts=stereo," +
        `volume=${decibels(sourceVolume)},` +
        `afade=t=in:st=0:d=${seconds(fadeFrames, plan.fps)},` +
        `afade=t=out:st=${seconds(fadeOutStart, plan.fps)}:d=${seconds(fadeFrames, plan.fps)},` +
        `adelay=delays=${String(Math.round(secondsFromFrames(scene.startFrame, plan.fps) * 1000))}:all=1` +
        `[${sourceLabel}]`,
    );
    labels.push(sourceLabel);
    inputIndex += 1;
  }

  if (labels.length === 0) {
    return {expectedAudio: false, filterGraph: "", inputArgs, outputLabel: "", warnings};
  }
  const totalDuration = seconds(plan.totalFrames, plan.fps);
  const mixedLabel = labels.length === 1 ? labels[0]! : "audioMixed";
  if (labels.length > 1) {
    filters.push(
      `${labels.map((label) => `[${label}]`).join("")}` +
        `amix=inputs=${String(labels.length)}:normalize=0:dropout_transition=0[${mixedLabel}]`,
    );
  }
  filters.push(
    `[${mixedLabel}]apad=pad_dur=${totalDuration},atrim=duration=${totalDuration}[audioBase]`,
  );
  return {
    expectedAudio: true,
    filterGraph: filters.join(";"),
    inputArgs,
    outputLabel: "audioBase",
    warnings,
  };
};

const readNumber = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const metadataChecks = async (
  intermediatePath: string,
  outputPath: string,
  probe: MediaProbe,
): Promise<VerifyCheck[]> => {
  const [input, output] = await Promise.all([
    probe.probe(intermediatePath),
    probe.probe(outputPath),
  ]);
  const inputVideo = input.streams?.find((stream) => stream.codec_type === "video");
  const outputVideo = output.streams?.find((stream) => stream.codec_type === "video");
  const inputDuration = readNumber(input.format?.duration);
  const outputDuration = readNumber(output.format?.duration);
  const durationDifference =
    inputDuration === null || outputDuration === null
      ? null
      : Math.abs(inputDuration - outputDuration);
  const inputBitrate = readNumber(inputVideo?.bit_rate);
  const outputBitrate = readNumber(outputVideo?.bit_rate);
  const bitrateRatio =
    inputBitrate === null || outputBitrate === null || inputBitrate === 0
      ? null
      : outputBitrate / inputBitrate;
  const durationPass = durationDifference !== null && durationDifference <= 0.1;
  const copyPass =
    inputVideo?.codec_name === "h264" &&
    outputVideo?.codec_name === "h264" &&
    bitrateRatio !== null &&
    Math.abs(1 - bitrateRatio) <= 0.05;
  return [
    {
      message: durationPass
        ? "무음 영상과 최종 영상의 길이가 같습니다."
        : "최종 영상의 길이가 무음 영상과 다릅니다.",
      metrics: {
        differenceSec: durationDifference,
        inputSec: inputDuration,
        outputSec: outputDuration,
      },
      name: "duration",
      status: durationPass ? "pass" : "fail",
    },
    {
      message: copyPass
        ? "H.264 비디오를 다시 인코딩하지 않고 그대로 복사했습니다."
        : "비디오 스트림 복사 여부를 확인하지 못했습니다.",
      metrics: {
        bitrateRatio,
        inputBitrate,
        inputCodec: inputVideo?.codec_name ?? null,
        outputBitrate,
        outputCodec: outputVideo?.codec_name ?? null,
      },
      name: "video-copy",
      status: copyPass ? "pass" : "fail",
    },
  ];
};

const blackCheck = async (
  outputPath: string,
  durationSec: number,
  ffmpegPath: string,
  signal: AbortSignal | undefined,
): Promise<VerifyCheck> => {
  const output = await runCaptured(
    ffmpegPath,
    [
      "-hide_banner",
      "-i",
      outputPath,
      "-vf",
      "blackdetect=d=0.5:pix_th=0.10",
      "-an",
      "-f",
      "null",
      "-",
    ],
    {signal},
  );
  const blackDuration = [...output.matchAll(/black_duration:([0-9.]+)/gu)]
    .map((match) => Number(match[1]))
    .reduce((sum, value) => sum + value, 0);
  const ratio = durationSec <= 0 ? 1 : blackDuration / durationSec;
  return {
    message: ratio < 0.05 ? "검은 구간이 전체의 5% 미만입니다." : "검은 구간이 너무 깁니다.",
    metrics: {blackDurationSec: blackDuration, blackRatio: ratio, threshold: 0.05},
    name: "blackdetect",
    status: ratio < 0.05 ? "pass" : "fail",
  };
};

const silenceCheck = async (
  outputPath: string,
  durationSec: number,
  ffmpegPath: string,
  signal: AbortSignal | undefined,
): Promise<VerifyCheck> => {
  const output = await runCaptured(
    ffmpegPath,
    [
      "-hide_banner",
      "-i",
      outputPath,
      "-map",
      "0:a:0",
      "-af",
      "silencedetect=n=-50dB:d=0.5",
      "-f",
      "null",
      "-",
    ],
    {signal},
  );
  let openStart: number | null = null;
  let silentDuration = 0;
  for (const match of output.matchAll(/silence_(start|end):\s*([0-9.]+)/gu)) {
    const value = Number(match[2]);
    if (match[1] === "start") {
      openStart = value;
    } else if (openStart !== null) {
      silentDuration += Math.max(0, value - openStart);
      openStart = null;
    }
  }
  if (openStart !== null) {
    silentDuration += Math.max(0, durationSec - openStart);
  }
  const ratio = durationSec <= 0 ? 1 : silentDuration / durationSec;
  const pass = ratio < 0.95;
  return {
    message: pass ? "오디오가 전 구간 무음이 아닙니다." : "오디오가 거의 전 구간 무음입니다.",
    metrics: {silenceRatio: ratio, silentDurationSec: silentDuration, threshold: 0.95},
    name: "silencedetect",
    status: pass ? "pass" : "fail",
  };
};

const loudnessCheck = async (
  outputPath: string,
  ffmpegPath: string,
  signal: AbortSignal | undefined,
): Promise<VerifyCheck> => {
  const output = await runCaptured(
    ffmpegPath,
    ["-hide_banner", "-i", outputPath, "-map", "0:a:0", "-af", firstPassFilter, "-f", "null", "-"],
    {signal},
  );
  const measurement = parseLoudnorm(output);
  const difference = Math.abs(measurement.inputI - LOUDNESS_TARGET);
  const pass = difference <= 1.5;
  return {
    message: pass
      ? "최종 음량이 -16 LUFS 목표 범위입니다."
      : "최종 음량이 목표 범위를 벗어났습니다.",
    metrics: {
      actualLufs: measurement.inputI,
      differenceLufs: difference,
      targetLufs: LOUDNESS_TARGET,
      toleranceLufs: 1.5,
      truePeakDbtp: measurement.inputTp,
    },
    name: "loudnorm",
    status: pass ? "pass" : "fail",
  };
};

const brightnessCheck = async (
  outputPath: string,
  totalFrames: number,
  fps: number,
  transcoder: MediaTranscoder,
  signal: AbortSignal | undefined,
): Promise<VerifyCheck> => {
  const sampleRoot = await mkdtemp(path.join(tmpdir(), "travel-brightness-"));
  try {
    const frameIndexes = Array.from({length: 10}, (_, index) =>
      Math.min(totalFrames - 1, Math.floor(((index + 1) * totalFrames) / 11)),
    );
    const select = frameIndexes.map((frame) => `eq(n\\,${String(frame)})`).join("+");
    await transcoder.run(
      [
        "-y",
        "-i",
        outputPath,
        "-vf",
        `select='${select}'`,
        "-vsync",
        "0",
        "-frames:v",
        "10",
        "-an",
        path.join(sampleRoot, "frame-%02d.png"),
      ],
      {durationSec: totalFrames / fps, signal},
    );
    const means: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const samplePath = path.join(sampleRoot, `frame-${String(index + 1).padStart(2, "0")}.png`);
      const statistics = await sharp(await readFile(samplePath)).stats();
      const channels = statistics.channels.slice(0, 3);
      means.push(channels.reduce((sum, channel) => sum + channel.mean, 0) / channels.length);
    }
    const darkFrames = means.filter((mean) => mean < 5).length;
    const pass = darkFrames < 3;
    return {
      message: pass
        ? "고르게 뽑은 10프레임의 밝기가 정상입니다."
        : "고르게 뽑은 프레임 중 어두운 화면이 너무 많습니다.",
      metrics: {
        darkFrames,
        maxBrightness: Math.max(...means),
        minBrightness: Math.min(...means),
        samples: means.length,
      },
      name: "brightness-samples",
      status: pass ? "pass" : "fail",
    };
  } finally {
    await rm(sampleRoot, {force: true, maxRetries: 5, recursive: true, retryDelay: 100});
  }
};

export class FinalizeValidationError extends Error {
  constructor(readonly report: VerifyReport) {
    super("최종 영상 검증을 통과하지 못했습니다. 검증 결과를 확인하세요.");
    this.name = "FinalizeValidationError";
  }
}

export class FinalVideoFinalizer {
  readonly #dependencies: FinalVideoFinalizerDependencies;

  constructor(dependencies: FinalVideoFinalizerDependencies) {
    this.#dependencies = dependencies;
  }

  outputPath(projectId: string): string {
    return path.join(this.#dependencies.outputRoot, projectId, "movie.mp4");
  }

  reportKey(projectId: string): string {
    return `manifests/${projectId}/finalize-verify-report.json`;
  }

  async finalize(
    inputPlan: RenderPlan,
    intermediatePath: string,
    options: FinalizeVideoOptions,
  ): Promise<FinalizeStepOutput> {
    const plan = renderPlanSchema.parse(inputPlan);
    const outputPath = this.outputPath(options.projectId);
    await mkdir(path.dirname(outputPath), {recursive: true});
    const temporaryPath = path.join(
      path.dirname(outputPath),
      `.movie.${String(process.pid)}.${randomUUID()}.tmp.mp4`,
    );
    try {
      options.onProgress?.(0.04, "오디오 입력을 확인하는 중");
      const audio = await buildAudioMix(plan, this.#dependencies);
      const commonInputs = ["-hide_banner", "-y", "-i", intermediatePath, ...audio.inputArgs];

      if (!audio.expectedAudio) {
        options.onProgress?.(0.32, "음악 없이 비디오 스트림을 복사하는 중");
        await this.#dependencies.transcoder.run(
          [
            ...commonInputs,
            "-map",
            "0:v:0",
            "-map_metadata",
            "-1",
            "-c:v",
            "copy",
            "-an",
            "-movflags",
            "+faststart",
            "-metadata",
            `title=${options.title}`,
            "-metadata",
            `date=${new Date().toISOString()}`,
            "-metadata",
            "comment=Created locally with AutoVeo",
            temporaryPath,
          ],
          {
            durationSec: plan.totalFrames / plan.fps,
            onProgress: (progress) =>
              options.onProgress?.(0.32 + progress * 0.28, "무음 최종 파일을 만드는 중"),
            signal: options.signal,
          },
        );
      } else {
        options.onProgress?.(0.15, "1차 라우드니스 측정 중");
        const passOne = await runCaptured(
          this.#dependencies.ffmpegPath,
          [
            ...commonInputs,
            "-filter_complex",
            `${audio.filterGraph};[${audio.outputLabel}]${firstPassFilter}[loudnessMeasured]`,
            "-map",
            "[loudnessMeasured]",
            "-f",
            "null",
            "-",
          ],
          {signal: options.signal},
        );
        const measurement = parseLoudnorm(passOne);
        options.onProgress?.(0.34, "2차 라우드니스 보정과 음악 합성 중");
        await this.#dependencies.transcoder.run(
          [
            ...commonInputs,
            "-filter_complex",
            `${audio.filterGraph};[${audio.outputLabel}]${secondPassFilter(measurement)}[audioFinal]`,
            "-map",
            "0:v:0",
            "-map",
            "[audioFinal]",
            "-map_metadata",
            "-1",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-movflags",
            "+faststart",
            "-metadata",
            `title=${options.title}`,
            "-metadata",
            `date=${new Date().toISOString()}`,
            "-metadata",
            "comment=Created locally with AutoVeo",
            temporaryPath,
          ],
          {
            durationSec: plan.totalFrames / plan.fps,
            onProgress: (progress) =>
              options.onProgress?.(0.34 + progress * 0.26, "음악을 최종 영상에 합치는 중"),
            signal: options.signal,
          },
        );
      }

      options.onProgress?.(0.63, "영상과 오디오를 검증하는 중");
      const metadata = await this.#dependencies.probe.probe(temporaryPath);
      const durationSec = readNumber(metadata.format?.duration) ?? plan.totalFrames / plan.fps;
      const checks = await metadataChecks(
        intermediatePath,
        temporaryPath,
        this.#dependencies.probe,
      );
      checks.push(
        await blackCheck(temporaryPath, durationSec, this.#dependencies.ffmpegPath, options.signal),
      );
      if (audio.expectedAudio) {
        checks.push(
          await silenceCheck(
            temporaryPath,
            durationSec,
            this.#dependencies.ffmpegPath,
            options.signal,
          ),
        );
        checks.push(
          await loudnessCheck(temporaryPath, this.#dependencies.ffmpegPath, options.signal),
        );
      } else {
        checks.push(
          {
            message: "음악 없음과 모든 장면 음소거 설정에 따라 오디오 트랙을 넣지 않았습니다.",
            metrics: {hasAudio: false},
            name: "silencedetect",
            status: "skipped",
          },
          {
            message: "오디오가 없어 라우드니스 측정을 건너뛰었습니다.",
            metrics: {hasAudio: false},
            name: "loudnorm",
            status: "skipped",
          },
        );
      }
      checks.push(
        await brightnessCheck(
          temporaryPath,
          plan.totalFrames,
          plan.fps,
          this.#dependencies.transcoder,
          options.signal,
        ),
      );
      for (const warning of audio.warnings) {
        checks.push({
          message: warning,
          metrics: {},
          name: "source-audio",
          status: "warning",
        });
      }
      const report = verifyReportSchema.parse({
        checks,
        createdAt: new Date().toISOString(),
        outputPath,
        projectId: options.projectId,
        schemaVersion: 2,
        status: checks.some((check) => check.status === "fail") ? "fail" : "pass",
      });
      const reportKey = this.reportKey(options.projectId);
      await this.#dependencies.storage.write(
        reportKey,
        Buffer.from(JSON.stringify(report, null, 2)),
      );
      if (report.status !== "pass") {
        throw new FinalizeValidationError(report);
      }
      options.onProgress?.(0.96, "검증을 통과한 최종 파일을 저장하는 중");
      try {
        await rename(temporaryPath, outputPath);
      } catch (error) {
        const isReplaceError =
          error instanceof Error &&
          "code" in error &&
          (error.code === "EEXIST" || error.code === "EPERM");
        if (!isReplaceError) {
          throw error;
        }
        await rm(outputPath, {force: true});
        await rename(temporaryPath, outputPath);
      }
      const info = await stat(outputPath);
      options.onProgress?.(1, "최종 영상 완성");
      return {
        hasAudio: audio.expectedAudio,
        outputPath,
        reportKey,
        size: info.size,
        status: "pass",
      };
    } finally {
      await rm(temporaryPath, {force: true});
    }
  }
}

const parseOutput = (output: unknown): FinalizeStepOutput => {
  const value = output as Partial<FinalizeStepOutput>;
  if (
    typeof value.outputPath !== "string" ||
    typeof value.reportKey !== "string" ||
    typeof value.size !== "number" ||
    typeof value.hasAudio !== "boolean" ||
    value.status !== "pass"
  ) {
    throw new Error("캐시된 최종 영상 정보가 올바르지 않습니다.");
  }
  return value as FinalizeStepOutput;
};

export const finalizeStepInputHash = async (
  projectId: string,
  dependencies: Pick<FinalizeStepDependencies, "storage">,
): Promise<string> => {
  const [planBuffer, visualHash] = await Promise.all([
    dependencies.storage.read(renderPlanKey(projectId)),
    renderStepInputHash(projectId, dependencies),
  ]);
  const plan = renderPlanSchema.parse(JSON.parse(planBuffer.toString("utf8")));
  return createHash("sha1")
    .update(JSON.stringify(plan))
    .update(visualHash)
    .update(`|${String(FINALIZE_CODE_VERSION)}`)
    .digest("hex");
};

export const createFinalizeStep = (
  projectId: string,
  title: string,
  dependencies: FinalizeStepDependencies,
): Step => ({
  codeVersion: FINALIZE_CODE_VERSION,
  invalidates: ["verify"],
  name: "finalize",
  outputRef: (output) => parseOutput(output).outputPath,
  restoreCached: async (output) => {
    const cached = parseOutput(output);
    await Promise.all([access(cached.outputPath), dependencies.storage.read(cached.reportKey)]);
  },
  run: async (context) => {
    const plan = renderPlanSchema.parse(
      JSON.parse((await dependencies.storage.read(renderPlanKey(projectId))).toString("utf8")),
    );
    const intermediatePath = await dependencies.storage.localPath(intermediateVideoKey(projectId));
    await access(intermediatePath);
    return dependencies.finalizer.finalize(plan, intermediatePath, {
      onProgress: (progress, message) => context.report({message, progress}),
      projectId,
      signal: context.signal,
      title,
    });
  },
});
