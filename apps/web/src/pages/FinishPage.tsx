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
  const [catalogTick, setCatalogTick] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState<string | null>(null);

  const projectId = project?.id ?? null;
  const timelineReady = isDone(project?.steps.timeline?.state);
  const musicReady = isDone(project?.steps.music?.state);
  const renderReady = isDone(project?.steps.render?.state);

  const musicKey = `${projectId ?? "none"}:${project?.steps.music?.state ?? ""}:${catalogTick}`;
  const renderKey = `${projectId ?? "none"}:${project?.steps.render?.state ?? ""}:${
    project?.steps.finalize?.state ?? ""
  }`;

  const libraryState = useRemoteData<MusicLibrary | null>(
    useCallback(
      () =>
        projectId === null
          ? Promise.resolve(null)
          : api.getMusicLibrary(projectId).catch(() => null),
      [projectId],
    ),
    musicKey,
  );
  const catalogState = useRemoteData<Awaited<ReturnType<typeof api.getMusicCatalog>> | null>(
    useCallback(
      () =>
        api
          .getMusicCatalog()
          .catch(() => null as unknown as Awaited<ReturnType<typeof api.getMusicCatalog>>),
      [],
    ),
    `catalog:${catalogTick}`,
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
  const catalog = catalogState.data as {
    catalog: {
      tracks: {
        id: string;
        path: string;
        mood: string[];
        energy: number;
        attribution: string;
        durationSec?: number;
      }[];
    };
    files: string[];
  } | null;
  const selection = selectionState.data;
  const result = resultState.data;
  // manual에서는 library가 없으면 catalog로 폴백
  const displayTracks =
    library !== null && library.tracks.length > 0
      ? (library.tracks as {
          id: string;
          path: string;
          mood: string[];
          energy: number;
          attribution: string;
          durationSec?: number;
        }[])
      : ((
          catalog?.catalog as
            | {
                tracks: {
                  id: string;
                  path: string;
                  mood: string[];
                  energy: number;
                  attribution: string;
                  durationSec?: number;
                }[];
              }
            | undefined
        )?.tracks ?? []);
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

            {mode === "auto" ? (
              <div className="stack">
                <div className="notice">
                  <strong>자동 추천</strong> — <span className="mono">music/</span> 폴더 안의 모든
                  MP3를 자동으로 찾아 <span className="mono">config/music/tracks.json</span>에
                  등록한 뒤, 영상의 무드·에너지에 맞는 곡을 추천합니다. 파일을 넣고 아래 버튼을
                  누르면 바로 반영됩니다.
                </div>
                <div className="btn-row">
                  <button
                    className="btn"
                    disabled={pipeline.busy || uploading}
                    onClick={async () => {
                      setCatalogMessage(null);
                      try {
                        const res = await api.refreshMusicCatalog();
                        setCatalogMessage(res.message);
                        setCatalogTick((v) => v + 1);
                      } catch (e) {
                        setCatalogMessage(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    type="button"
                  >
                    music 폴더 스캔하여 json 생성/갱신
                  </button>
                  {library !== null ? (
                    <span className="panel-note" style={{alignSelf: "center"}}>
                      현재 등록 {library.tracks.length}곡
                    </span>
                  ) : null}
                </div>
                {catalogMessage !== null ? <div className="notice">{catalogMessage}</div> : null}
                {library !== null && library.warnings.length > 0 ? (
                  <div className="stack">
                    {library.warnings.map((w) => (
                      <div className="notice notice-warn" key={`${w.trackId}:${w.code}`}>
                        {w.message}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {mode === "manual" ? (
              <div className="stack">
                <div className="notice">
                  <strong>직접 선택</strong> — PC에서 MP3를 직접 고르거나, 서버 파일 대화상자로
                  선택할 수 있습니다. 선택한 파일은 <span className="mono">music/manual/</span>에
                  복사되어 카탈로그에 자동 등록됩니다.
                </div>
                <div className="btn-row" style={{gap: 8, flexWrap: "wrap"}}>
                  <label className="btn" style={{cursor: uploading ? "not-allowed" : "pointer"}}>
                    {uploading ? "업로드 중…" : "PC에서 MP3 직접 선택"}
                    <input
                      accept=".mp3,audio/mpeg"
                      disabled={uploading || pipeline.busy}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file === undefined || file === null) return;
                        setUploading(true);
                        setCatalogMessage(null);
                        try {
                          const base64 = await new Promise<string>((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => {
                              const result = reader.result as string;
                              const comma = result.indexOf(",");
                              resolve(comma >= 0 ? result.slice(comma + 1) : result);
                            };
                            reader.onerror = () => reject(reader.error);
                            reader.readAsDataURL(file);
                          });
                          const res = await api.uploadMusic(file.name, base64);
                          setCatalogMessage(`업로드 완료: ${res.path}`);
                          setCatalogTick((v) => v + 1);
                          setTrackId((res.track as {id: string}).id ?? null);
                        } catch (err) {
                          setCatalogMessage(err instanceof Error ? err.message : String(err));
                        } finally {
                          setUploading(false);
                          e.target.value = "";
                        }
                      }}
                      style={{display: "none"}}
                      type="file"
                    />
                  </label>
                  <button
                    className="btn"
                    disabled={uploading || pipeline.busy}
                    onClick={async () => {
                      setCatalogMessage(null);
                      try {
                        const res = await api.selectMusicFile();
                        if (res.filePath === null) {
                          setCatalogMessage("선택 취소됨");
                        } else {
                          setCatalogMessage(`선택됨: ${res.filePath}`);
                          setCatalogTick((v) => v + 1);
                        }
                      } catch (err) {
                        setCatalogMessage(err instanceof Error ? err.message : String(err));
                      }
                    }}
                    type="button"
                  >
                    서버 파일 대화상자로 선택
                  </button>
                  <button
                    className="btn"
                    disabled={uploading || pipeline.busy}
                    onClick={async () => {
                      setCatalogMessage(null);
                      try {
                        const res = await api.refreshMusicCatalog();
                        setCatalogMessage(res.message);
                        setCatalogTick((v) => v + 1);
                      } catch (e) {
                        setCatalogMessage(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    type="button"
                  >
                    music 폴더 다시 스캔
                  </button>
                </div>
                {catalogMessage !== null ? <div className="notice">{catalogMessage}</div> : null}
                {catalogState.data === null && library === null ? (
                  <div className="notice notice-warn">카탈로그를 불러오는 중…</div>
                ) : displayTracks.length === 0 ? (
                  <div className="notice notice-warn">
                    등록된 음악이 없습니다. 위에서 MP3를 직접 선택하거나,{" "}
                    <span className="mono">music/</span> 폴더에 MP3를 넣고 다시 스캔하세요.
                  </div>
                ) : (
                  <div className="track-list">
                    {displayTracks.map((track) => {
                      const isLibrary = library?.tracks.some((t) => t.id === track.id) ?? false;
                      const durationSec = (track as {durationSec?: number}).durationSec;
                      return (
                        <div
                          className="track-row"
                          data-selected={trackId === track.id}
                          key={track.id}
                        >
                          <div>
                            <div className="track-name">{track.id}</div>
                            <div className="track-meta">
                              {track.mood.join(", ")} · 에너지 {Math.round(track.energy * 100)}% ·{" "}
                              {durationSec !== undefined
                                ? `${Math.round(durationSec)}초`
                                : "길이 미측정"}{" "}
                              · {track.attribution} · <span className="mono">{track.path}</span>
                              {!isLibrary ? " · 카탈로그" : ""}
                            </div>
                          </div>
                          {isLibrary ? (
                            <audio
                              controls
                              preload="none"
                              src={api.musicPreviewUrl(project!.id, track.id)}
                            />
                          ) : (
                            <span className="panel-note">미리듣기는 음악 적용 후 가능</span>
                          )}
                          <button
                            className={`btn btn-sm ${trackId === track.id ? "" : "btn-primary"}`}
                            onClick={() => setTrackId(track.id)}
                            type="button"
                          >
                            {trackId === track.id ? "선택됨" : "선택"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
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
