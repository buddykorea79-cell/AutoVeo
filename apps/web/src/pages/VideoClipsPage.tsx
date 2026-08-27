import {useCallback, useState} from "react";
import {Link} from "react-router-dom";

import {api} from "../api";
import {JobProgress} from "../components/JobProgress";
import {EmptyState, PageHead} from "../components/PageHead";
import {SegmentPreview} from "../components/SegmentPreview";
import {isDone, type PipelineState} from "../hooks/usePipeline";
import {useRemoteData} from "../hooks/useRemoteData";
import type {VideoSegmentView, VideoSegmentsResponse, VideoSourceView, WebProject} from "../types";

interface VideoClipsPageProps {
  readonly pipeline: PipelineState;
  readonly project: WebProject | null;
}

const EMPTY: VideoSegmentsResponse = {videos: []};

/** 구간을 미세 조정할 때 한 번에 움직이는 시간. */
const NUDGE_SEC = 0.5;

const formatSec = (value: number): string => {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
};

const scoreTone = (score: number): string =>
  score >= 82 ? "pill-good" : score >= 68 ? "pill-accent" : "pill-warn";

export const VideoClipsPage = ({pipeline, project}: VideoClipsPageProps) => {
  const [busySegment, setBusySegment] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectId = project?.id ?? null;
  const sourceReady = isDone(project?.steps.fingerprint?.state);
  const detected = isDone(project?.steps["detect-video-segments"]?.state);
  const extracted = isDone(project?.steps["extract-video-clips"]?.state);

  const segmentState = useRemoteData<VideoSegmentsResponse>(
    useCallback(
      () => (projectId === null ? Promise.resolve(EMPTY) : api.getVideoSegments(projectId)),
      [projectId],
    ),
    `${projectId ?? "none"}:${project?.steps["detect-video-segments"]?.state ?? ""}:${
      project?.steps["extract-video-clips"]?.state ?? ""
    }`,
  );
  const videos = segmentState.data?.videos ?? EMPTY.videos;

  const mutate = async (
    action: () => Promise<VideoSegmentsResponse>,
    segmentId: string,
  ): Promise<void> => {
    setBusySegment(segmentId);
    setError(null);
    try {
      segmentState.set(await action());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusySegment(null);
    }
  };

  const nudge = async (
    video: VideoSourceView,
    segment: VideoSegmentView,
    edge: "start" | "end",
    direction: -1 | 1,
  ): Promise<void> => {
    if (projectId === null) {
      return;
    }
    const delta = NUDGE_SEC * direction;
    const startSec = edge === "start" ? Math.max(0, segment.startSec + delta) : segment.startSec;
    const endSec =
      edge === "end" ? Math.min(video.durationSec, segment.endSec + delta) : segment.endSec;
    await mutate(
      () => api.patchVideoSegment(projectId, segment.id, {endSec, startSec}),
      segment.id,
    );
  };

  const addSegment = async (video: VideoSourceView): Promise<void> => {
    if (projectId === null) {
      return;
    }
    // 아직 쓰지 않은 자리부터 기본 8초 구간을 제안한다.
    const lastEnd = video.segments.reduce(
      (maximum, segment) => Math.max(maximum, segment.endSec),
      0,
    );
    const startSec = Math.min(lastEnd, Math.max(0, video.durationSec - 8));
    const endSec = Math.min(video.durationSec, startSec + 8);
    await mutate(
      () => api.addVideoSegment(projectId, {endSec, mediaId: video.mediaId, startSec}),
      `new-${video.mediaId}`,
    );
  };

  const selectedCount = videos.reduce(
    (sum, video) => sum + video.segments.filter((segment) => segment.selected).length,
    0,
  );
  const readyCount = videos.reduce(
    (sum, video) =>
      sum + video.segments.filter((segment) => segment.selected && segment.clip !== null).length,
    0,
  );

  if (project === null) {
    return (
      <EmptyState
        action={
          <Link className="btn btn-primary" to="/source">
            소스 폴더 열기
          </Link>
        }
        body="먼저 소스 폴더를 열고 원본을 불러오세요."
        title="프로젝트가 없습니다"
      />
    );
  }

  return (
    <>
      <PageHead
        actions={
          <>
            <button
              className="btn"
              disabled={pipeline.busy || !sourceReady}
              onClick={() => void pipeline.run("detect-video-segments", {force: false})}
              type="button"
            >
              {detected ? "구간 다시 찾기" : "좋은 구간 찾기"}
            </button>
            <button
              className="btn btn-primary"
              disabled={pipeline.busy || !detected || selectedCount === 0}
              onClick={() => void pipeline.run("extract-video-clips", {force: false})}
              type="button"
            >
              선택 구간을 클립으로 ({selectedCount})
            </button>
          </>
        }
        eyebrow="3단계"
        lede="촬영 영상에서 쓸 만한 구간을 자동으로 찾습니다. 확인하고 고른 구간만 잘라서 클립으로 만듭니다."
        title="영상 → 클립"
      />

      <div className="stack">
        <JobProgress
          error={pipeline.error}
          live={pipeline.live}
          onStop={() => void pipeline.stop()}
        />
        {error === null ? null : <div className="notice notice-bad">{error}</div>}

        {!sourceReady ? (
          <EmptyState
            action={
              <Link className="btn btn-primary" to="/source">
                소스로 이동
              </Link>
            }
            body="원본 불러오기를 먼저 끝내야 영상을 분석할 수 있습니다."
            title="원본 준비가 필요합니다"
          />
        ) : !detected ? (
          <EmptyState
            body="'좋은 구간 찾기'를 누르면 영상마다 움직임과 화질을 살펴 쓸 만한 구간을 추천합니다."
            title="아직 찾은 구간이 없습니다"
          />
        ) : videos.length === 0 ? (
          <EmptyState
            action={
              <Link className="btn btn-primary" to="/clips">
                클립으로 이동
              </Link>
            }
            body="이 폴더에는 촬영 영상이 없습니다. 사진 그룹 클립만으로 타임라인을 만들 수 있습니다."
            title="촬영 영상이 없습니다"
          />
        ) : (
          <>
            <div className="stat-row">
              <div className="stat">
                <div className="stat-value">{videos.length}</div>
                <div className="stat-label">촬영 영상</div>
              </div>
              <div className="stat">
                <div className="stat-value">
                  {videos.reduce((sum, video) => sum + video.segments.length, 0)}
                </div>
                <div className="stat-label">찾은 구간</div>
              </div>
              <div className="stat">
                <div className="stat-value">{selectedCount}</div>
                <div className="stat-label">선택한 구간</div>
              </div>
              <div className="stat">
                <div className="stat-value">{readyCount}</div>
                <div className="stat-label">만들어진 클립</div>
              </div>
            </div>

            {videos.map((video) => (
              <section className="panel" key={video.mediaId}>
                <div className="panel-head">
                  <h2>{video.filename}</h2>
                  <span className="row">
                    <span className="faint" style={{fontSize: 12}}>
                      전체 {formatSec(video.durationSec)} · 구간 {video.segments.length}개
                    </span>
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={busySegment !== null}
                      onClick={() => void addSegment(video)}
                      type="button"
                    >
                      구간 직접 추가
                    </button>
                  </span>
                </div>

                {/* 영상 전체에서 각 구간이 어디에 있는지 한눈에 보여 준다. */}
                <div className="seg-track">
                  {video.segments.map((segment) => (
                    <span
                      className="seg-track-block"
                      data-selected={segment.selected}
                      key={segment.id}
                      style={{
                        left: `${String((segment.startSec / video.durationSec) * 100)}%`,
                        width: `${String((segment.durationSec / video.durationSec) * 100)}%`,
                      }}
                      title={`${formatSec(segment.startSec)} → ${formatSec(segment.endSec)}`}
                    />
                  ))}
                </div>

                <div className="segment-grid">
                  {video.segments.map((segment) => (
                    <article
                      className="segment-card"
                      data-selected={segment.selected}
                      key={segment.id}
                    >
                      <div className="clip-media">
                        <SegmentPreview
                          clipUrl={segment.clipUrl}
                          endSec={segment.endSec}
                          // 구간이 바뀌면 다시 마운트해 새 범위로 재생하게 한다.
                          key={`${segment.startSec}-${segment.endSec}-${segment.clipUrl ?? ""}`}
                          label={`${video.filename} ${formatSec(segment.startSec)}`}
                          sourceUrl={video.previewUrl}
                          startSec={segment.startSec}
                          thumbUrl={segment.thumbUrl}
                        />
                        <span className="clip-score">{segment.score}</span>
                        <span className="clip-kind">
                          {formatSec(segment.startSec)} → {formatSec(segment.endSec)} ·{" "}
                          {segment.durationSec.toFixed(1)}s
                        </span>
                      </div>
                      <div className="clip-body">
                        <div className="chip-row">
                          <span className={`pill ${scoreTone(segment.score)}`}>
                            {segment.source === "user" ? "직접 추가" : "자동 추천"}
                          </span>
                          {segment.clip === null ? null : <span className="pill">클립 완성</span>}
                        </div>
                        <p className="clip-desc">{segment.reason}</p>

                        <div className="nudge-row">
                          <span className="faint">시작</span>
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={busySegment !== null}
                            onClick={() => void nudge(video, segment, "start", -1)}
                            type="button"
                          >
                            −
                          </button>
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={busySegment !== null}
                            onClick={() => void nudge(video, segment, "start", 1)}
                            type="button"
                          >
                            +
                          </button>
                          <span className="faint">끝</span>
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={busySegment !== null}
                            onClick={() => void nudge(video, segment, "end", -1)}
                            type="button"
                          >
                            −
                          </button>
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={busySegment !== null}
                            onClick={() => void nudge(video, segment, "end", 1)}
                            type="button"
                          >
                            +
                          </button>
                        </div>

                        <div className="clip-foot">
                          <span className="faint" style={{fontSize: 12}}>
                            {segment.clip === null ? "원본에서 구간 재생" : "잘라 낸 클립"}
                          </span>
                          <span className="row">
                            {segment.source === "user" ? (
                              <button
                                className="btn btn-sm btn-ghost"
                                disabled={busySegment !== null || projectId === null}
                                onClick={() =>
                                  void mutate(
                                    () => api.deleteVideoSegment(projectId!, segment.id),
                                    segment.id,
                                  )
                                }
                                type="button"
                              >
                                삭제
                              </button>
                            ) : null}
                            <button
                              className={`btn btn-sm ${segment.selected ? "" : "btn-primary"}`}
                              disabled={busySegment !== null || projectId === null}
                              onClick={() =>
                                void mutate(
                                  () =>
                                    api.patchVideoSegment(projectId!, segment.id, {
                                      selected: !segment.selected,
                                    }),
                                  segment.id,
                                )
                              }
                              type="button"
                            >
                              {segment.selected ? "빼기" : "넣기"}
                            </button>
                          </span>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}

            {extracted ? (
              <div className="btn-row">
                <Link className="btn btn-primary" to="/clips">
                  다음 · AI 클립 분석
                </Link>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
};
