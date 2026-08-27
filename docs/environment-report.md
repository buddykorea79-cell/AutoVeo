# Phase 0 Environment Report

Checked on 2026-08-18 (Asia/Seoul). All capability decisions below are based on commands executed on this machine.

## 1. Environment summary

| Item         | Observed value                                                                             |
| ------------ | ------------------------------------------------------------------------------------------ |
| OS           | Windows NT 10.0.26200.9168; registry `ProductName=Windows 10 Pro`, `DisplayVersion=25H2`   |
| Architecture | AMD64, 64-bit                                                                              |
| CPU          | AMD Ryzen 7 260 w/ Radeon 780M Graphics; 8 physical / 16 logical cores                     |
| Memory       | 23.31 GiB total; 11.95 GiB available at inspection time                                    |
| GPUs         | AMD Radeon 780M Graphics; NVIDIA GeForce RTX 5060 Laptop GPU                               |
| PowerShell   | 7.6.4                                                                                      |
| Node.js      | v24.19.0                                                                                   |
| npm / pnpm   | npm 11.17.0 / pnpm 11.19.0                                                                 |
| Git          | 2.55.0.windows.4                                                                           |
| Python       | Not on `PATH`; Codex bundled Python 3.12.13 is available but must not be an app dependency |
| Browser      | Google Chrome 151.0.7922.138                                                               |
| Repository   | Directory was empty, was not a Git repository, and had no `AGENTS.md`                      |

## 2. Available capabilities

### FFmpeg

No system `ffmpeg` or `ffprobe` is on `PATH`. An app-local probe using `ffmpeg-static@5.3.0` supplied FFmpeg 6.1.1 and passed these checks:

| Capability          | Result                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| Filters             | `zoompan`, `blackdetect`, `silencedetect`, `loudnorm`, `acrossfade`, `adelay`, `amix`, `afade`: all present |
| Video encoder       | `libx264`: present                                                                                          |
| Audio encoder       | `aac`: present                                                                                              |
| HEVC codec          | Decoder and encoders present                                                                                |
| HEIC/HEIF container | Not present; formats output showed AVIF encoding only                                                       |

`ffprobe-static@3.1.0` supplied FFprobe 4.0.2 and successfully inspected all Remotion probe outputs. Its version does not match the probed FFmpeg 6.1.1 build, so production code must resolve a matched FFmpeg/FFprobe pair rather than silently mixing these two packages.

### Images and HEIC

- `sharp@0.35.3` loaded with libvips 8.18.3.
- `sharp.format.heif` advertised AVIF input only.
- A HEVC HEIF round-trip failed with `heifsave: Unsupported compression`.
- ImageMagick was not installed.
- `heic-convert@2.1.0` converted the package's official 200,538-byte HEIC fixture to a 537,258-byte JPEG; Sharp then read it as 1440×960 JPEG.

### Remotion and Chromium

`remotion@4.0.513` rendered the same 12-frame, 320×180, 24 fps H.264 composition with installed Chrome under all three requested GL modes:

| GL mode       | Result | Output                      |
| ------------- | ------ | --------------------------- |
| `angle`       | Pass   | H.264/AAC MP4, 29,275 bytes |
| `swangle`     | Pass   | H.264/AAC MP4, 29,304 bytes |
| `swiftshader` | Pass   | H.264/AAC MP4, 29,304 bytes |

The Korean workspace path was part of the successful render path.

### Korean fonts

The system contains `malgun.ttf`, `malgunbd.ttf`, `malgunsl.ttf`, `batang.ttc`, `gulim.ttc`, and `NotoSansKR-VF.ttf`. A repository font bundle is still required for deterministic rendering on other machines.

## 3. Missing capabilities and selected alternatives

| Missing or unsuitable capability | Selected alternative                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| System FFmpeg/FFprobe            | Add an explicit binary resolver and startup capability check. Prefer configured matched binaries; do not depend on ambient `PATH` alone. |
| Sharp HEVC-based HEIC input      | Decode `.heic` / `.heif` with `heic-convert` in a worker, then pass its JPEG buffer to Sharp.                                            |
| ImageMagick                      | Not required for v1 because `heic-convert` passed an actual HEIC fixture.                                                                |
| Python on `PATH`                 | Do not require Python in the application pipeline.                                                                                       |
| Repository font                  | Bundle Noto Sans KR and gate Remotion with `delayRender()` until it loads.                                                               |

## 4. Final HEIC path

Use **`heic-convert → JPEG buffer → sharp`** for `.heic` and `.heif`. Use Sharp directly for JPEG, PNG, WebP, and TIFF. Run HEIC conversion in a worker thread because the converter performs substantial synchronous work.

## 5. Final Remotion GL option

Use **`chromiumOptions.gl = "angle"`** on this Windows machine. It produced a valid H.264 MP4 using installed Chrome. Keep `swangle` as an explicit software fallback for headless or driver-problem environments; it also passed the same render probe.

## 6. Main risks

1. **No matched FFmpeg toolchain is installed.** Phase 1 must expose binary configuration and Phase 7 must refuse rendering when required filters or encoders are missing.
2. **HEIC fallback is CPU-heavy and partly synchronous.** It must run outside the API event loop, be cached, and be covered by a real-fixture integration test.

## 7. Next step

Proceed to Phase 1: initialize the pnpm monorepo, add `AGENTS.md`, create the React/Fastify/package skeleton, implement `StorageAdapter` plus `LocalFsAdapter`, add SQLite migrations, and verify lint, typecheck, tests, and `/api/health`.

## Command evidence

Key observed output:

```text
node --version       -> v24.19.0
pnpm --version       -> 11.19.0
git --version        -> git version 2.55.0.windows.4
PhysicalCores        -> 8
LogicalCores         -> 16
ffmpeg -version      -> 6.1.1-essentials_build-www.gyan.dev
required filters     -> all true
libx264 / aac        -> both true
sharp HEIC roundtrip -> NO: heifsave: Unsupported compression
heic-convert fixture -> JPEG 1440x960
Remotion angle       -> exit 0, out-angle.mp4
Remotion swangle     -> exit 0, out-swangle.mp4
Remotion swiftshader -> exit 0, out-swiftshader.mp4
```
