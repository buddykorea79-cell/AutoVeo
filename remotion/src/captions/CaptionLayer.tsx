import {AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig} from "remotion";

import type {RenderCaption, RenderScene} from "@travel-movie/schema";

const CaptionCard = ({caption}: {readonly caption: RenderCaption}) => {
  const frame = useCurrentFrame();
  const {height, width} = useVideoConfig();
  const portrait = height > width;
  const fadeInOpacity =
    caption.fadeInFrames === 0
      ? 1
      : interpolate(frame, [0, caption.fadeInFrames], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  const fadeOutOpacity =
    caption.fadeOutFrames === 0
      ? 1
      : interpolate(
          frame,
          [caption.durationInFrames - caption.fadeOutFrames, caption.durationInFrames - 1],
          [1, 0],
          {extrapolateLeft: "clamp", extrapolateRight: "clamp"},
        );

  const title = caption.kind === "chapter-title";
  /*
   * 글자 크기는 화면 가로폭에 비례시키되, 세로 영상에서는 폭이 좁아 너무 작아지므로
   * 짧은 변이 아니라 가로폭 기준을 쓰고 세로 영상만 비율을 키운다.
   * 720p 에서 약 46px, 1080p 에서 약 69px, 4K 에서 약 138px 이 된다.
   */
  const fontSize = Math.round(width * (title ? 0.048 : 0.036) * (portrait ? 1.35 : 1));

  return (
    <AbsoluteFill style={{opacity: Math.min(fadeInOpacity, fadeOutOpacity)}}>
      <div
        style={{
          background:
            "linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.34) 45%, rgba(0,0,0,0) 100%)",
          bottom: 0,
          height: "36%",
          left: 0,
          position: "absolute",
          right: 0,
        }}
      />
      <div
        style={{
          bottom: portrait ? "16%" : "8.5%",
          color: "#ffffff",
          fontFamily: "PretendardVariable, 'Noto Sans KR', sans-serif",
          fontSize,
          fontWeight: title ? 800 : 700,
          left: portrait ? "6%" : "7.5%",
          letterSpacing: "-0.02em",
          lineHeight: 1.32,
          overflowWrap: "break-word",
          // 밝은 하늘·눈 위에서도 읽히도록 그림자에 얇은 윤곽을 더한다.
          paintOrder: "stroke fill",
          position: "absolute",
          right: portrait ? "6%" : "7.5%",
          textAlign: "center",
          textShadow: `0 ${String(Math.round(fontSize * 0.04))}px ${String(
            Math.round(fontSize * 0.28),
          )}px rgba(0,0,0,0.72), 0 0 ${String(Math.round(fontSize * 0.1))}px rgba(0,0,0,0.5)`,
          WebkitTextStroke: `${(fontSize * 0.022).toFixed(2)}px rgba(0,0,0,0.42)`,
          wordBreak: "keep-all",
        }}
      >
        {caption.lines.map((line, index) => (
          <div key={`${String(index)}-${line}`}>{line}</div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const CaptionLayer = ({scene}: {readonly scene: RenderScene}) => (
  <AbsoluteFill>
    {scene.captions.map((caption, index) => (
      <Sequence
        key={`${caption.startFrame}-${String(index)}`}
        from={caption.startFrame - scene.startFrame}
        durationInFrames={caption.durationInFrames}
        layout="absolute-fill"
        name={`Caption ${String(index + 1)}`}
      >
        <CaptionCard caption={caption} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
