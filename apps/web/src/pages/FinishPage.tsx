import {useCallback, useState} from "react";
import {Link} from "react-router-dom";

import {api} from "../api";
import {JobProgress} from "../components/JobProgress";
import {EmptyState, PageHead} from "../components/PageHead";
import {isDone, type PipelineState} from "../hooks/usePipeline";
import {useRemoteData} from "../hooks/useRemoteData";
import type {MusicLibrary, MusicSelection, RenderResult, WebProject} from "../types";

interface FinishPageProps {
  readonly pipeline: PipelineState;
  readonly project: WebProject | null;
}

type MusicMode = "auto" | "manual" | "none";

const CHECK_LABEL: Record<string, string> = {
  blackdetect: "검은 화면 비율",
  "brightness-samples": "밝기 표본",
  duration: "길이 일치",
  loudnorm: "음량(LUFS)",
  silencedetect: "음악 소리 확인",
  "video-copy": "영상 재인코딩 없음",
};

const statusTone = (status: string): string =>
  status === "pass" ? "pill-good" : status === "fail" ? "pill-bad" : "pill-warn";

export const FinishPage = ({pipeline, project}: FinishPageProps) => {
  const [modeOverride, setModeOverride] = useState<MusicMode | null>(null);
  const [trackOverride, setTrackOverride] = useState<string | null>(null);

  const projectId = project?.id ?? null;
  const timelineReady = isDone(project?.steps.timeline?.state);
  const musicReady = isDone(project?.steps.music?.state);
  const renderReady = isDone(project?.steps.render?.state);

  const musicKey = `${projectId ?? "none"}:${project?.steps.music?.state ?? ""}`;
  const renderKey = `${projectId ?? "none"}:${project?.steps.render?.state ?? ""}:${
    project?.steps.finalize?.state ?? ""
  }`;

  const libraryState = useRemoteData<MusicLibrary | null>(
    useCallback(
      () => (projectId === null ? Promise.resolve(null) : api.getMusicLibrary(projectId)),
      [projectId],
    ),
    musicKey,
  );
  const selectionState = useRemoteData<MusicSelection | null>(
    useCallback(
      () => (projectId === null ? Promise.resolve(null) : api.getMusicSelection(projectId)),
      [projectId],
    ),
    musicKey,
  );
  const resultState = useRemoteData<RenderResult | null>(
    useCallback(
      () => (projectId === null ? Promise.resolve(null) : api.getRenderResult(projectId)),
      [projectId],
    ),
    renderKey,
  );

  const library = libraryState.data;
  const selection = selectionState.data;
  const result = resultState.data;
  const mode: MusicMode = modeOverride ?? selection?.mode ?? "auto";
  const trackId = trackOverride ?? selection?.choices[0]?.trackId ?? null;
  const setMode = setModeOverride;
  const setTrackId = setTrackOverride;

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

  if (!timelineReady) {
    return (
      <>
        <PageHead eyebrow="6단계" title="음악과 최종 영상" />
        <EmptyState
          action={
            <Link className="btn btn-primary" to="/timeline">
              타임라인으로 이동
            </Link>
          }
          body="타임라인을 먼저 만들어야 음악 길이와 렌더 입력이 정해집니다."
          title="타임라인이 필요합니다"
        />
      </>
    );
  }

  return (
    <>
      <PageHead
        eyebrow="6단계"
        lede="배경음악을 고르고, 무음 영상을 만든 뒤 음악을 합쳐 최종 영상을 완성합니다."
        title="음악과 최종 영상"
      />

      <div className="stack">
        <JobProgress
          error={pipeline.error}
          live={pipeline.live}
          onStop={() => void pipeline.stop()}
        />

        <section className="panel">
          <div className="panel-head">
            <h2>배경음악</h2>
            <span className="pill">{musicReady ? "선택 완료" : "선택 필요"}</span>
          </div>
          <div className="stack">
            <div className="seg" style={{alignSelf: "flex-start"}}>
              {(
                [
                  ["auto", "자동 추천"],
                  ["manual", "직접 선택"],
                  ["none", "음악 없음"],
                ] as const
              ).map(([value, label]) => (
                <button
                  aria-pressed={mode === value}
                  key={value}
                  onClick={() => setMode(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === "manual" ? (
              library === null || library.tracks.length === 0 ? (
                <div className="notice notice-warn">
                  사용할 수 있는 음악이 없습니다. <span className="mono">music/</span> 폴더에 MP3를
                  넣고 <span className="mono">config/music/tracks.json</span>에 등록한 뒤 자동
                  추천을 한 번 실행하세요.
                </div>
              ) : (
                <div className="track-list">
                  {library.tracks.map((track) => (
                    <div className="track-row" data-selected={trackId === track.id} key={track.id}>
                      <div>
                        <div className="track-name">{track.id}</div>
                        <div className="track-meta">
                          {track.mood.join(", ")} · 에너지 {Math.round(track.energy * 100)}% ·{" "}
                          {Math.round(track.durationSec)}초 · {track.attribution}
                        </div>
                      </div>
                      <audio
                        controls
                        preload="none"
                        src={api.musicPreviewUrl(project.id, track.id)}
                      />
                      <button
                        className={`btn btn-sm ${trackId === track.id ? "" : "btn-primary"}`}
                        onClick={() => setTrackId(track.id)}
                        type="button"
                      >
                        {trackId === track.id ? "선택됨" : "선택"}
                      </button>
                    </div>
                  ))}
                </div>
              )
            ) : null}

            {selection === null ? null : (
              <div className="stack">
                {selection.choices.map((choice) => (
                  <div className="notice" key={choice.startChapterId}>
                    <strong>{choice.trackId}</strong> — {choice.reason}
                  </div>
                ))}
                {selection.warnings.map((warning) => (
                  <div className="notice notice-warn" key={warning.code}>
                    {warning.message}
                  </div>
                ))}
              </div>
            )}

            <div className="btn-row">
              <button
                className="btn btn-primary"
                disabled={pipeline.busy || (mode === "manual" && trackId === null)}
                onClick={() =>
                  void pipeline.run("music", {
                    force: false,
                    mode,
                    trackIds: mode === "manual" && trackId !== null ? [trackId] : [],
                  })
                }
                type="button"
              >
                이 설정으로 음악 넣기
              </button>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>최종 영상 만들기</h2>
            <span className="pill">
              {result?.finalReady === true ? "완성" : renderReady ? "음악 합성 대기" : "렌더 대기"}
            </span>
          </div>
          <div className="stack">
            <div className="btn-row">
              <button
                className="btn"
                disabled={pipeline.busy || !musicReady}
                onClick={() => void pipeline.run("render", {force: false})}
                type="button"
              >
                1. 무음 영상 만들기
              </button>
              <button
                className="btn btn-primary"
                disabled={pipeline.busy || !renderReady}
                onClick={() => void pipeline.run("finalize", {force: false})}
                type="button"
              >
                2. 음악 합쳐 완성
              </button>
            </div>
            {musicReady ? null : <p className="panel-note">먼저 위에서 배경음악을 적용하세요.</p>}

            {result?.finalReady === true && result.finalUrl !== null ? (
              <>
                <div className="video-frame">
                  <video controls playsInline preload="metadata" src={result.finalUrl} />
                </div>
                <div className="btn-row">
                  <a className="btn btn-primary" href={`${result.finalUrl}?download=1`}>
                    MP4 다운로드
                  </a>
                </div>
              </>
            ) : result?.intermediateReady === true && result.intermediateUrl !== null ? (
              <>
                <p className="panel-note">무음 미리보기입니다. 소리가 나지 않는 것이 정상입니다.</p>
                <div className="video-frame">
                  <video
                    controls
                    muted
                    playsInline
                    preload="metadata"
                    src={result.intermediateUrl}
                  />
                </div>
              </>
            ) : null}

            {result?.report === null || result?.report === undefined ? null : (
              <div className="stack">
                <div className="row" style={{justifyContent: "space-between"}}>
                  <h2>자동 검증</h2>
                  <span className={`pill ${statusTone(result.report.status)}`}>
                    {result.report.status === "pass" ? "통과" : "확인 필요"}
                  </span>
                </div>
                <ul className="check-list">
                  {result.report.checks.map((check) => (
                    <li className="check-row" key={check.name}>
                      <span>
                        <strong>{CHECK_LABEL[check.name] ?? check.name}</strong>
                        <span className="dim"> — {check.message}</span>
                      </span>
                      <span className={`pill ${statusTone(check.status)}`}>{check.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
};
