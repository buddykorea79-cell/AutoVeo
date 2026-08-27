import {useCallback, useRef, useState} from "react";

import {ViewportImage} from "./ViewportImage";

interface SegmentPreviewProps {
  /** 구간을 잘라 만든 클립. 있으면 이 파일을 그대로 재생한다. */
  readonly clipUrl: string | null;
  readonly endSec: number;
  readonly label: string;
  /** 원본(프록시) 스트림. 아직 자르기 전에는 여기서 구간만 재생한다. */
  readonly sourceUrl: string;
  readonly startSec: number;
  readonly thumbUrl: string | null;
}

/**
 * 구간을 확인하기 위한 미리보기.
 *
 * 아직 클립을 만들기 전에는 원본 프록시를 불러와 startSec 로 건너뛰고
 * endSec 에서 멈춘다. `#t=` 미디어 프래그먼트는 preload 설정에 따라 무시되는
 * 브라우저가 있어 직접 currentTime 을 다룬다.
 *
 * 구간을 조절하면 부모가 key 를 바꿔 이 컴포넌트를 다시 마운트하므로,
 * 열려 있던 미리보기는 저절로 닫히고 다음에 새 범위로 다시 열린다.
 */
export const SegmentPreview = ({
  clipUrl,
  endSec,
  label,
  sourceUrl,
  startSec,
  thumbUrl,
}: SegmentPreviewProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attach = useCallback(
    (element: HTMLVideoElement | null) => {
      videoRef.current = element;
      if (element === null) {
        return;
      }
      // 잘라 낸 클립은 처음부터 재생하면 되고, 원본은 구간 시작으로 건너뛴다.
      if (clipUrl === null) {
        element.currentTime = startSec;
      }
      void element.play().catch(() => {
        // 자동 재생을 막는 설정이면 사용자가 직접 재생 버튼을 누르면 된다.
      });
    },
    [clipUrl, startSec],
  );

  const onTimeUpdate = (): void => {
    const element = videoRef.current;
    if (element === null || clipUrl !== null) {
      return;
    }
    if (element.currentTime >= endSec) {
      element.pause();
      element.currentTime = startSec;
    }
  };

  if (!active) {
    return (
      <button
        aria-label={`${label} 구간 미리보기`}
        className="segment-poster"
        onClick={() => setActive(true)}
        type="button"
      >
        <ViewportImage alt={label} src={thumbUrl} />
        <span className="segment-play">▶ 미리보기</span>
      </button>
    );
  }

  return (
    <div className="segment-player">
      <video
        controls
        muted
        onError={() =>
          setError("이 구간을 재생할 수 없습니다. 원본 미리보기가 준비되지 않았을 수 있습니다.")
        }
        onLoadedMetadata={(event) => {
          if (clipUrl === null) {
            event.currentTarget.currentTime = startSec;
          }
        }}
        onTimeUpdate={onTimeUpdate}
        playsInline
        preload="auto"
        ref={attach}
        src={clipUrl ?? sourceUrl}
      />
      {error === null ? null : <div className="notice notice-bad">{error}</div>}
    </div>
  );
};
