import type {ProgressEvent, StepName} from "../types";

const STEP_LABEL: Record<StepName, string> = {
  "analyze-clips": "AI 클립 분석",
  assemble: "영상 구성",
  "detect-video-segments": "영상 구간 찾기",
  "extract-video-clips": "영상 클립 자르기",
  fingerprint: "사진 품질 확인",
  finalize: "음악 합성과 검증",
  "group-clips": "그룹 클립 생성",
  music: "배경음악 선택",
  prepare: "미리보기 만들기",
  render: "무음 영상 렌더",
  scan: "원본 스캔",
  subtitle: "자막 계획",
  timeline: "타임라인 계산",
};

interface JobProgressProps {
  readonly error?: string | null;
  readonly live: ProgressEvent | null;
  readonly onStop?: () => void;
}

export const JobProgress = ({error, live, onStop}: JobProgressProps) => {
  if (live === null && (error === null || error === undefined)) {
    return null;
  }
  if (live === null) {
    return <div className="notice notice-bad">{error}</div>;
  }
  const percent = Math.round(live.progress * 100);
  return (
    <div className="job-card">
      <div className="job-line">
        <span className="job-step">{STEP_LABEL[live.step] ?? live.step}</span>
        <span className="row">
          <span className="faint mono">{percent}%</span>
          {onStop === undefined ? null : (
            <button className="btn btn-sm btn-ghost" onClick={onStop} type="button">
              중지
            </button>
          )}
        </span>
      </div>
      <div className="progress">
        <i style={{width: `${String(percent)}%`}} />
      </div>
      {live.message === null ? null : <div className="job-message">{live.message}</div>}
    </div>
  );
};
