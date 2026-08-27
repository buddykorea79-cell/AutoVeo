import {useCallback, useMemo, useState} from "react";
import {Link} from "react-router-dom";

import {api} from "../api";
import {JobProgress} from "../components/JobProgress";
import {EmptyState, PageHead} from "../components/PageHead";
import {ViewportImage} from "../components/ViewportImage";
import {isDone, type PipelineState} from "../hooks/usePipeline";
import {useRemoteData} from "../hooks/useRemoteData";
import type {ClipsResponse, ClipView, WebProject} from "../types";

interface TimelinePageProps {
  readonly pipeline: PipelineState;
  readonly project: WebProject | null;
}

const EMPTY_CLIPS: readonly ClipView[] = [];

const CAPTION_LIMIT = 22;

const formatDuration = (seconds: number): string => {
  const total = Math.round(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

export const TimelinePage = ({pipeline, project}: TimelinePageProps) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [captionDraft, setCaptionDraft] = useState<{clipId: string; text: string} | null>(null);
  const [saving, setSaving] = useState(false);
  const projectId = project?.id ?? null;
  const analyzed = isDone(project?.steps["analyze-clips"]?.state);
  const built = isDone(project?.steps.timeline?.state);

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

  const warningState = useRemoteData<{readonly warnings: readonly string[]}>(
    useCallback(
      () =>
        projectId === null || !built
          ? Promise.resolve({warnings: []})
          : api.getTimelineWarnings(projectId),
      [built, projectId],
    ),
    `${projectId ?? "none"}:${project?.steps.timeline?.state ?? ""}`,
  );
  const warnings = warningState.data?.warnings ?? [];

  const selected = useMemo(
    () => clips.filter((clip) => clip.selected).toSorted((a, b) => a.order - b.order),
    [clips],
  );
  const active = useMemo(
    () => selected.find((clip) => clip.id === activeId) ?? selected[0] ?? null,
    [activeId, selected],
  );

  // 편집 중인 문장은 선택한 클립에 묶어 둔다. 클립을 바꾸면 저장된 자막이 다시 보인다.
  const draft =
    captionDraft !== null && captionDraft.clipId === active?.id
      ? captionDraft.text
      : (active?.caption?.text ?? "");
  const setDraft = (text: string): void => {
    if (active !== null) {
      setCaptionDraft({clipId: active.id, text});
    }
  };

  const totalSec = selected.reduce((sum, clip) => sum + clip.durationSec, 0);

  const move = async (clipId: string, direction: -1 | 1): Promise<void> => {
    if (projectId === null) {
      return;
    }
    const order = selected.map((clip) => clip.id);
    const index = order.indexOf(clipId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) {
      return;
    }
    [order[index], order[target]] = [order[target]!, order[index]!];
    const others = clips
      .filter((clip) => !clip.selected)
      .toSorted((a, b) => a.order - b.order)
      .map((clip) => clip.id);
    clipState.set(await api.reorderClips(projectId, [...order, ...others]));
  };

  const saveCaption = async (text: string): Promise<void> => {
    if (projectId === null || active === null) {
      return;
    }
    setSaving(true);
    try {
      clipState.set(
        await api.patchClip(projectId, active.id, {
          caption: text.trim().length === 0 ? null : text.trim(),
        }),
      );
      setCaptionDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const removeFromTimeline = async (clipId: string): Promise<void> => {
    if (projectId === null) {
      return;
    }
    clipState.set(await api.patchClip(projectId, clipId, {selected: false}));
  };

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

  const longCaption = draft.split("\n").some((line) => line.length > CAPTION_LIMIT * 2);

  return (
    <>
      <PageHead
        actions={
          <button
            className="btn btn-primary"
            disabled={pipeline.busy || selected.length === 0}
            onClick={() => void pipeline.run("timeline", {force: false})}
            type="button"
          >
            {built ? "타임라인 다시 만들기" : "타임라인 만들기"}
          </button>
        }
        eyebrow="5단계"
        lede="선택한 클립의 순서를 정하고 자막을 붙입니다. 길이는 선택한 클립 길이의 합으로 정해집니다."
        title="타임라인과 자막"
      />

      <div className="stack">
        <JobProgress
          error={pipeline.error}
          live={pipeline.live}
          onStop={() => void pipeline.stop()}
        />

        {!analyzed ? (
          <EmptyState
            action={
              <Link className="btn btn-primary" to="/clips">
                클립으로 이동
              </Link>
            }
            body="AI 클립 분석을 먼저 끝내야 타임라인을 구성할 수 있습니다."
            title="분석한 클립이 필요합니다"
          />
        ) : selected.length === 0 ? (
          <EmptyState
            action={
              <Link className="btn btn-primary" to="/clips">
                클립 고르기
              </Link>
            }
            body="타임라인에 넣을 클립을 한 개 이상 선택하세요."
            title="선택한 클립이 없습니다"
          />
        ) : (
          <>
            <section className="panel">
              <div className="panel-head">
                <h2>타임라인</h2>
                <span className="row" style={{gap: 8}}>
                  <span className="pill">{selected.length}컷</span>
                  <span className="pill pill-accent">{formatDuration(totalSec)}</span>
                </span>
              </div>
              <div className="tl-strip">
                {selected.map((clip) => (
                  <button
                    className="tl-block"
                    data-active={clip.id === active?.id}
                    key={clip.id}
                    onClick={() => setActiveId(clip.id)}
                    style={{flexGrow: clip.durationSec, flexBasis: 0}}
                    title={`${clip.title} · ${clip.durationSec.toFixed(1)}초`}
                    type="button"
                  >
                    {clip.durationSec >= totalSec / 18 ? clip.durationSec.toFixed(0) : ""}
                  </button>
                ))}
              </div>

              <div className="tl-rows">
                {selected.map((clip, index) => (
                  <div className="tl-row" data-active={clip.id === active?.id} key={clip.id}>
                    <div className="tl-order">{index + 1}</div>
                    <button
                      className="tl-thumb"
                      onClick={() => setActiveId(clip.id)}
                      style={{border: "none", padding: 0, width: "100%"}}
                      type="button"
                    >
                      <ViewportImage alt={clip.title} src={clip.thumbUrl} />
                    </button>
                    <button
                      onClick={() => setActiveId(clip.id)}
                      style={{
                        background: "none",
                        border: "none",
                        minWidth: 0,
                        padding: 0,
                        textAlign: "left",
                      }}
                      type="button"
                    >
                      <div className="clip-title">{clip.title}</div>
                      <div
                        className={`tl-caption ${clip.caption === null ? "tl-caption-empty" : ""}`}
                      >
                        {clip.caption?.text ?? "자막 없음"}
                      </div>
                    </button>
                    <div className="btn-row">
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={index === 0}
                        onClick={() => void move(clip.id, -1)}
                        title="앞으로"
                        type="button"
                      >
                        ↑
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={index === selected.length - 1}
                        onClick={() => void move(clip.id, 1)}
                        title="뒤로"
                        type="button"
                      >
                        ↓
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => void removeFromTimeline(clip.id)}
                        title="타임라인에서 빼기"
                        type="button"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {active === null ? null : (
              <section className="panel">
                <div className="panel-head">
                  <h2>자막 — {active.title}</h2>
                  <span className="pill">
                    {active.caption?.source === "user"
                      ? "직접 작성"
                      : active.caption === null
                        ? "없음"
                        : "AI 초안"}
                  </span>
                </div>
                <div className="grid-2">
                  <video
                    className="video-frame"
                    controls
                    muted
                    playsInline
                    preload="metadata"
                    src={active.previewUrl}
                  />
                  <div className="stack">
                    <label className="field">
                      <span>이 장면의 자막</span>
                      <textarea
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder="한 줄 22자, 최대 두 줄을 권장합니다."
                        value={draft}
                      />
                    </label>
                    {longCaption ? (
                      <div className="notice notice-warn">
                        문장이 길어 두 줄에 들어가지 않을 수 있습니다. 내용을 임의로 줄이지 않으니
                        직접 다듬어 주세요.
                      </div>
                    ) : null}
                    <div className="btn-row">
                      <button
                        className="btn btn-primary"
                        disabled={saving}
                        onClick={() => void saveCaption(draft)}
                        type="button"
                      >
                        자막 저장
                      </button>
                      <button
                        className="btn btn-ghost"
                        disabled={saving || draft.length === 0}
                        onClick={() => void saveCaption("")}
                        type="button"
                      >
                        자막 지우기
                      </button>
                    </div>
                    <p className="panel-note">
                      직접 저장한 자막은 다시 분석해도 덮어쓰지 않습니다. 자막은 전체 컷의 60%까지만
                      화면에 올라갑니다.
                    </p>
                  </div>
                </div>
              </section>
            )}

            {warnings.length === 0 ? null : (
              <div className="notice notice-warn">
                {warnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            )}

            {built ? (
              <div className="btn-row">
                <Link className="btn btn-primary" to="/finish">
                  다음 · 음악과 완성
                </Link>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
};
