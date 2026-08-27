import {createReadStream} from "node:fs";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import sharp from "sharp";

import {renderPlanSchema} from "@travel-movie/schema";

import {runtimeConfig, workspaceRoot} from "../config.js";
import {FfmpegService} from "../services/ffmpeg.js";
import {FfprobeService} from "../services/ffprobe.js";
import {RemotionRenderService} from "../services/remotion.js";
import {verifyRenderedVideo} from "../services/verify-render.js";
import {LocalFsAdapter} from "../storage/local-fs-adapter.js";

const palettes = [
  ["#71b9d2", "#d6edf0", "#255d72", "#e7b26a", "#274a3d"],
  ["#8ac6c2", "#f0d8a8", "#3f7470", "#ef925a", "#4b633b"],
  ["#b9d7a8", "#f3e8b8", "#587f45", "#f4b55e", "#37634e"],
  ["#ef9a75", "#f6c88f", "#6c4d76", "#ffd37a", "#253a62"],
  ["#24385f", "#5c6f98", "#19233f", "#f0b064", "#142b35"],
] as const;

const scenicSvg = (index: number): Buffer => {
  const [sky, horizon, mountain, sun, foreground] = palettes[index]!;
  const sunX = 420 + index * 420;
  const ridge = 650 + index * 35;
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="2688" height="1512" viewBox="0 0 2688 1512">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${sky}"/>
          <stop offset="1" stop-color="${horizon}"/>
        </linearGradient>
        <linearGradient id="water" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${mountain}"/>
          <stop offset="1" stop-color="${foreground}"/>
        </linearGradient>
        <pattern id="grain" width="28" height="28" patternUnits="userSpaceOnUse">
          <circle cx="4" cy="7" r="2" fill="#fff" opacity=".16"/>
          <circle cx="18" cy="21" r="1.5" fill="#000" opacity=".12"/>
        </pattern>
      </defs>
      <rect width="2688" height="1512" fill="url(#sky)"/>
      <circle cx="${String(sunX)}" cy="350" r="145" fill="${sun}" opacity=".92"/>
      <path d="M0 ${String(ridge + 180)} L420 ${String(ridge - 80)} L790 ${String(ridge + 70)} L1190 ${String(ridge - 210)} L1580 ${String(ridge + 40)} L2050 ${String(ridge - 120)} L2688 ${String(ridge + 150)} L2688 1110 L0 1110 Z" fill="${mountain}" opacity=".86"/>
      <path d="M0 920 C520 820 880 1050 1380 920 C1840 800 2250 910 2688 820 L2688 1512 L0 1512 Z" fill="url(#water)"/>
      <path d="M0 1160 C480 1080 780 1240 1180 1160 C1640 1060 2100 1210 2688 1080 L2688 1512 L0 1512 Z" fill="${foreground}" opacity=".82"/>
      <path d="M120 1290 Q720 1120 1310 1320 T2570 1250" fill="none" stroke="${sun}" stroke-width="34" opacity=".52"/>
      <rect width="2688" height="1512" fill="url(#grain)"/>
    </svg>
  `);
};

const createDemoAssets = async (
  storage: LocalFsAdapter,
  transcoder: FfmpegService,
): Promise<void> => {
  for (let index = 0; index < palettes.length; index += 1) {
    const image = await sharp(scenicSvg(index)).jpeg({quality: 90}).toBuffer();
    await storage.write(`render-assets/demo-0${String(index + 1)}.jpg`, image);
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "travel-demo-video-"));
  try {
    const proxyPath = path.join(temporaryRoot, "demo-video.mp4");
    await transcoder.run([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=30:duration=5",
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      proxyPath,
    ]);
    await storage.write("proxies/demo-video.mp4", createReadStream(proxyPath));
  } finally {
    await rm(temporaryRoot, {force: true, maxRetries: 5, recursive: true, retryDelay: 100});
  }
};

const run = async (): Promise<void> => {
  if (runtimeConfig.ffmpegPath === null || runtimeConfig.ffprobePath === null) {
    throw new Error(
      "FFmpeg/ffprobe 바이너리를 찾을 수 없습니다. FFMPEG_PATH/FFPROBE_PATH를 설정하세요.",
    );
  }
  const storage = new LocalFsAdapter(runtimeConfig.storageRoot);
  const transcoder = new FfmpegService(runtimeConfig.ffmpegPath);
  const probe = new FfprobeService(runtimeConfig.ffprobePath);
  const plan = renderPlanSchema.parse(
    JSON.parse(
      await readFile(path.join(workspaceRoot, "examples", "demo-render-plan.json"), "utf8"),
    ),
  );
  await createDemoAssets(storage, transcoder);
  let reportedPercent = -5;
  const renderer = new RemotionRenderService({
    browserExecutable: runtimeConfig.remotionBrowserExecutable,
    remotionRoot: path.join(workspaceRoot, "remotion"),
    storage,
  });
  const rendered = await renderer.render(plan, {
    onProgress: (progress) => {
      const percent = Math.floor(progress * 100);
      if (percent >= reportedPercent + 5 || percent === 100) {
        reportedPercent = percent;
        console.log(`Remotion ${String(percent)}%`);
      }
    },
    outputKey: "intermediate.mp4",
    planKey: "plans/demo-render-plan.json",
  });
  const report = await verifyRenderedVideo(
    rendered.outputPath,
    plan,
    {
      captionFrameKey: "verification/demo-caption-frame.png",
      projectId: "demo",
      reportKey: "manifests/demo-verify-report.json",
    },
    {ffmpegPath: runtimeConfig.ffmpegPath!, probe, storage, transcoder},
  );
  console.log(JSON.stringify({rendered, report}, null, 2));
  if (report.status !== "pass") {
    throw new Error("Demo render verification failed");
  }
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
