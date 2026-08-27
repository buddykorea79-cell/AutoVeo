import {useCallback, useState} from "react";
import {Link} from "react-router-dom";

import {api} from "../api";
import {JobProgress} from "../components/JobProgress";
import {EmptyState, PageHead} from "../components/PageHead";
import {ViewportImage} from "../components/ViewportImage";
import {isDone, type PipelineState} from "../hooks/usePipeline";
import {useRemoteData} from "../hooks/useRemoteData";
import type {MediaResponse, WebProject} from "../types";

interface SourcePageProps {
  readonly onProjectChange: (project: WebProject) => void;
  readonly onReset: () => void;
  readonly pipeline: PipelineState;
  readonly project: WebProject | null;
}

const EMPTY: MediaResponse = {
  items: [],
  summary: {excluded: 0, photos: 0, total: 0, videos: 0},
};

const formatTime = (value: string): string => value.slice(5, 16).replace("T", " ");

export const SourcePage = ({onProjectChange, onReset, pipeline, project}: SourcePageProps) => {
  const [title, setTitle] = useState("나의 영상");
  const [typedFolder, setTypedFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectId = project?.id ?? null;
  const scanned = isDone(project?.steps.scan?.state);
  const ready = isDone(project?.steps.fingerprint?.state);

  const settings = useRemoteData(
    useCallback(() => api.getAdminSettings(), []),
    "admin-settings",
  );
  const folderPath = typedFolder ?? settings.data?.lastFolderPath ?? "";

  const mediaState = useRemoteData<MediaResponse>(
    useCallback(
      () => (projectId === null ? Promise.resolve(EMPTY) : api.getMedia(projectId)),
      [projectId],
    ),
    `${projectId ?? "none"}:${project?.steps.scan?.state ?? ""}:${project?.steps.fingerprint?.state ?? ""}`,
  );
  const media = mediaState.data ?? EMPTY;

  const createProject = async (): Promise<void> => {
    setError(null);
    setCreating(true);
    try {
      const created = await api.createProject({folderPath: folderPath.trim(), title: title.trim()});
      onProjectChange(created);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  const browse = async (): Promise<void> => {
    try {
      const result = await api.selectFolder();
      if (result.folderPath !== null) {
        setTypedFolder(result.folderPath);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const toggleMedia = async (mediaId: string, excluded: boolean): Promise<void> => {
    if (projectId === null) {
      return;
    }
    mediaState.set(await api.setMediaDecision(projectId, mediaId, excluded ? "auto" : "exclude"));
  };

  if (project === null) {
    return (
      <>
        <PageHead
          eyebrow="1단계"
          lede="사진과 영상이 들어 있는 폴더를 고르면 됩니다. 원본은 읽기만 하고 절대 바꾸지 않습니다."
          title="소스 폴더 열기"
        />
        <section className="panel">
          <div className="stack">
            <label className="field">
              <span>영상 제목</span>
              <input onChange={(event) => setTitle(event.target.value)} type="text" value={title} />
            </label>
            <label className="field">
              <span>소스 폴더</span>
              <div className="row">
                <input
                  onChange={(event) => setTypedFolder(event.target.value)}
                  placeholder="D:\Travel\Jeju-2026"
                  type="text"
                  value={folderPath}
                />
                <button className="btn" onClick={() => void browse()} type="button">
                  찾아보기
                </button>
              </div>
            </label>
            {error === null ? null : <div className="notice notice-bad">{error}</div>}
            <div className="btn-row">
              <button
                className="btn btn-primary"
                disabled={creating || folderPath.trim().length === 0 || title.trim().length === 0}
                onClick={() => void createProject()}
                type="button"
              >
                {creating ? "만드는 중…" : "프로젝트 시작"}
              </button>
            </div>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <PageHead
        actions={
          <>
            <button className="btn btn-ghost" onClick={onReset} type="button">
              다른 폴더
            </button>
            <button
              className="btn btn-primary"
              disabled={pipeline.busy}
              onClick={() => void pipeline.run("import", {force: false})}
              type="button"
            >
              {scanned ? "다시 불러오기" : "원본 불러오기"}
            </button>
          </>
        }
        eyebrow="1단계"
        lede="원본을 훑어 촬영 시각을 읽고, 화면에 빠르게 띄울 미리보기와 품질 정보를 만듭니다."
        title={project.title}
      />

      <div className="stack">
        <div className="panel">
          <div className="panel-head">
            <h2>소스 폴더</h2>
            <span className="pill">{ready ? "준비 완료" : scanned ? "분석 필요" : "대기"}</span>
          </div>
          <p className="mono dim" style={{margin: 0, wordBreak: "break-all"}}>
            {project.folderPath}
          </p>
        </div>

        <JobProgress
          error={pipeline.error}
          live={pipeline.live}
          onStop={() => void pipeline.stop()}
        />

        {media.items.length === 0 ? (
          <EmptyState
            body="아직 읽어 온 원본이 없습니다. 위의 '원본 불러오기'를 누르면 사진과 영상을 훑고 미리보기를 만듭니다."
            title="원본을 불러오세요"
          />
        ) : (
          <>
            <div className="stat-row">
              <div className="stat">
                <div className="stat-value">{media.summary.total}</div>
                <div className="stat-label">전체 파일</div>
              </div>
              <div className="stat">
                <div className="stat-value">{media.summary.photos}</div>
                <div className="stat-label">사진</div>
              </div>
              <div className="stat">
                <div className="stat-value">{media.summary.videos}</div>
                <div className="stat-label">영상</div>
              </div>
              <div className="stat">
                <div className="stat-value">{media.summary.excluded}</div>
                <div className="stat-label">제외</div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <h2>원본 목록</h2>
                <span className="faint" style={{fontSize: 12}}>
                  클릭하면 제외하거나 되돌립니다
                </span>
              </div>
              <div className="media-grid">
                {media.items.map((item) => {
                  const excluded = item.userDecision === "exclude";
                  return (
                    <button
                      className="media-cell"
                      data-excluded={excluded}
                      key={item.id}
                      onClick={() => void toggleMedia(item.id, excluded)}
                      title={`${item.filename}\n${formatTime(item.capturedAtLocal)}`}
                      type="button"
                    >
                      <ViewportImage alt={item.filename} src={item.thumbUrl} />
                      {item.mediaType === "video" ? (
                        <span className="media-badge">VIDEO</span>
                      ) : item.issues.includes("blurry") ? (
                        <span className="media-badge">BLUR</span>
                      ) : null}
                      <span className="media-time">{formatTime(item.capturedAtLocal)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {ready ? (
              <div className="btn-row">
                <Link className="btn btn-primary" to="/groups">
                  다음 · 그룹 만들기
                </Link>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
};
