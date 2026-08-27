import {useCallback, useMemo, useState} from "react";
import {Link} from "react-router-dom";

import {
  LOOK_LABELS,
  LOOK_PRESET_VALUES,
  LOOK_SHORT_LABELS,
  lookCssFilter,
} from "@travel-movie/schema";

import {api} from "../api";
import {JobProgress} from "../components/JobProgress";
import {EmptyState, PageHead} from "../components/PageHead";
import {ViewportImage} from "../components/ViewportImage";
import {isDone, type PipelineState} from "../hooks/usePipeline";
import {useRemoteData} from "../hooks/useRemoteData";
import type {ClipsResponse, ClipView, LookPreset, WebProject} from "../types";

interface ClipsPageProps {
  readonly pipeline: PipelineState;
  readonly project: WebProject | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  action: "움직임",
  fly_through: "통과",
  general: "일반",
  highlight: "하이라이트",
  landscape_reveal: "풍경",
  orbit: "선회",
  static_beauty: "정적",
  subject_focus: "인물·피사체",
  transition: "전환",
};

const EMPTY_CLIPS: readonly ClipView[] = [];

type Filter = "all" | "selected" | "group" | "source";
type Sort = "order" | "score";

const scoreTone = (score: number): string =>
  score >= 82 ? "pill-good" : score >= 68 ? "pill-accent" : "pill-warn";

export const ClipsPage = ({pipeline, project}: ClipsPageProps) => {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("order");
  const [busyClip, setBusyClip] = useState<string | null>(null);
  const projectId = project?.id ?? null;
  // 그룹 클립이든 영상 클립이든, 만들어진 클립이 하나라도 있으면 분석할 수 있다.
  const groupsReady =
    isDone(project?.steps["group-clips"]?.state) ||
    isDone(project?.steps["extract-video-clips"]?.state);
  const analyzed = isDone(project?.steps["analyze-clips"]?.state);

  const clipState = useRemoteData<ClipsResponse>(
    useCallback(
      () =>
        projectId === null
          ? Promise.resolve({clips: [], totalDurationSec: 0})
          : api.getClips(projectId),
      [projectId],
    ),
    `${projectId ?? "none"}:${project?.steps["analyze-clips"]?.state ?? ""}`,
  );
  const clips = clipState.data?.clips ?? EMPTY_CLIPS;

  const toggle = async (clip: ClipView): Promise<void> => {
    if (projectId === null) {
      return;
    }
    setBusyClip(clip.id);
    try {
      clipState.set(await api.patchClip(projectId, clip.id, {selected: !clip.selected}));
    } finally {
      setBusyClip(null);
    }
  };

  const setLook = async (clip: ClipView, look: LookPreset): Promise<void> => {
    if (projectId === null) {
      return;
    }
    setBusyClip(clip.id);
    try {
      clipState.set(await api.patchClip(projectId, clip.id, {look}));
    } finally {
      setBusyClip(null);
    }
  };

  const applyLookToAll = async (look: LookPreset): Promise<void> => {
    if (projectId === null) {
      return;
    }
    setBusyClip("all");
    try {
      clipState.set(await api.applyLookToAll(projectId, look));
    } finally {
      setBusyClip(null);
    }
  };

  const visible = useMemo(() => {
    const filtered = clips.filter((clip) => {
      if (filter === "selected") {
        return clip.selected;
      }
      if (filter === "group" || filter === "source") {
        return clip.kind === filter;
      }
      return true;
    });
    return sort === "score"
      ? filtered.toSorted((left, right) => right.analysis.score - left.analysis.score)
      : filtered.toSorted((left, right) => left.order - right.order);
  }, [clips, filter, sort]);

  const selectedCount = clips.filter((clip) => clip.selected).length;
  const totalSec = clips
    .filter((clip) => clip.selected)
    .reduce((sum, clip) => sum + clip.durationSec, 0);
  const aiUsed = clips.some((clip) => clip.analysis.aiUsed);

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
          <button
            className="btn btn-primary"
            disabled={pipeline.busy || !groupsReady}
            onClick={() => void pipeline.run("analyze-clips", {force: false})}
            type="button"
          >
            {analyzed ? "다시 분석" : "AI로 클립 분석"}
          </button>
        }
        eyebrow="4단계"
        lede="사진 그룹 클립과 영상에서 잘라 낸 클립을 AI가 보고 점수를 매깁니다. 여기서 색감 필터도 고릅니다."
        title="추천 클립 고르기"
      />

      <div className="stack">
        <JobProgress
          error={pipeline.error}
          live={pipeline.live}
          onStop={() => void pipeline.stop()}
        />

        {!groupsReady ? (
          <EmptyState
            action={
              <Link className="btn btn-primary" to="/groups">
                그룹으로 이동
              </Link>
            }
            body="사진 그룹 클립을 만들거나 영상에서 클립을 잘라 내야 분석할 대상이 생깁니다."
            title="만들어진 클립이 없습니다"
          />
        ) : clips.length === 0 ? (
          <EmptyState
            body="'AI로 클립 분석'을 누르면 각 클립의 대표 프레임을 보고 점수·설명·자막 초안을 만듭니다."
            title="아직 분석한 클립이 없습니다"
          />
        ) : (
          <>
            <div className="stat-row">
              <div className="stat">
                <div className="stat-value">{clips.length}</div>
                <div className="stat-label">전체 클립</div>
              </div>
              <div className="stat">
                <div className="stat-value">{selectedCount}</div>
                <div className="stat-label">선택됨</div>
              </div>
              <div className="stat">
                <div className="stat-value">{totalSec.toFixed(0)}초</div>
                <div className="stat-label">예상 길이</div>
              </div>
              <div className="stat">
                <div className="stat-value">{aiUsed ? "AI" : "화질"}</div>
                <div className="stat-label">평가 기준</div>
              </div>
            </div>

            {aiUsed ? null : (
              <div className="notice notice-warn">
                비전 모델을 찾지 못해 화질·안정성만으로 점수를 매겼습니다. 설정에서 Ollama 비전
                모델을 지정하면 장면 설명과 자막 초안까지 만들어집니다.
              </div>
            )}

            <section className="panel">
              <div className="panel-head">
                <h2>색감 필터</h2>
                <span className="faint" style={{fontSize: 12}}>
                  클립마다 따로 고를 수 있습니다
                </span>
              </div>
              <div className="look-row">
                {LOOK_PRESET_VALUES.map((look) => (
                  <button
                    className="look-swatch"
                    disabled={busyClip !== null}
                    key={look}
                    onClick={() => void applyLookToAll(look)}
                    type="button"
                  >
                    <span className="look-chip" style={{filter: lookCssFilter(look)}}>
                      {LOOK_SHORT_LABELS[look]}
                    </span>
                    {LOOK_LABELS[look]}
                  </button>
                ))}
              </div>
              <p className="panel-note" style={{marginTop: 12}}>
                여기서 고르면 모든 클립에 한 번에 적용됩니다. 필터는 최종 렌더에서 입혀지므로 클립을
                다시 만들 필요가 없습니다.
              </p>
            </section>

            <div className="row wrap" style={{justifyContent: "space-between"}}>
              <div className="seg">
                {(
                  [
                    ["all", "전체"],
                    ["selected", "선택됨"],
                    ["group", "그룹 클립"],
                    ["source", "촬영 영상"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    aria-pressed={filter === value}
                    key={value}
                    onClick={() => setFilter(value)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="seg">
                {(
                  [
                    ["order", "순서순"],
                    ["score", "점수순"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    aria-pressed={sort === value}
                    key={value}
                    onClick={() => setSort(value)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="clip-grid">
              {visible.map((clip) => (
                <article className="clip-card" data-selected={clip.selected} key={clip.id}>
                  <div className="clip-media">
                    {/* 썸네일에 같은 필터를 걸어 결과를 미리 보여 준다. */}
                    <div style={{filter: lookCssFilter(clip.look), height: "100%", width: "100%"}}>
                      <ViewportImage alt={clip.title} src={clip.thumbUrl} />
                    </div>
                    <span className="clip-score">{clip.analysis.score}</span>
                    <span className="clip-kind">
                      {clip.kind === "group" ? "그룹" : "촬영"} · {clip.durationSec.toFixed(1)}s
                    </span>
                  </div>
                  <div className="clip-body">
                    <div className="clip-title">{clip.title}</div>
                    <p className="clip-desc">{clip.analysis.description}</p>
                    <div className="chip-row">
                      <span className={`pill ${scoreTone(clip.analysis.score)}`}>
                        {CATEGORY_LABEL[clip.analysis.category] ?? clip.analysis.category}
                      </span>
                      {clip.caption === null ? null : <span className="pill">자막 있음</span>}
                    </div>
                    <div className="look-row look-row-sm">
                      {LOOK_PRESET_VALUES.map((look) => (
                        <button
                          aria-pressed={clip.look === look}
                          className="look-swatch"
                          disabled={busyClip !== null}
                          key={look}
                          onClick={() => void setLook(clip, look)}
                          title={LOOK_LABELS[look]}
                          type="button"
                        >
                          <span className="look-chip" style={{filter: lookCssFilter(look)}}>
                            {LOOK_SHORT_LABELS[look]}
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="clip-foot">
                      <video
                        className="btn btn-sm btn-ghost"
                        controls
                        muted
                        playsInline
                        preload="none"
                        src={clip.previewUrl}
                        style={{width: 132, height: 32, padding: 0}}
                      />
                      <button
                        className={`btn btn-sm ${clip.selected ? "" : "btn-primary"}`}
                        disabled={busyClip === clip.id}
                        onClick={() => void toggle(clip)}
                        type="button"
                      >
                        {clip.selected ? "빼기" : "넣기"}
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>

            {analyzed ? (
              <div className="btn-row">
                <Link className="btn btn-primary" to="/timeline">
                  다음 · 타임라인 만들기
                </Link>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
};
