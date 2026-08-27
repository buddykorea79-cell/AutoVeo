import {useCallback, useMemo, useState} from "react";
import {Link} from "react-router-dom";

import {CLIP_STYLE_DESCRIPTIONS, CLIP_STYLE_LABELS, CLIP_STYLE_VALUES} from "@travel-movie/schema";

import {api} from "../api";
import {JobProgress} from "../components/JobProgress";
import {EmptyState, PageHead} from "../components/PageHead";
import {ViewportImage} from "../components/ViewportImage";
import {isDone, type PipelineState} from "../hooks/usePipeline";
import {useRemoteData} from "../hooks/useRemoteData";
import type {ClipStyle, GroupView, GroupsResponse, OutputSettings, WebProject} from "../types";

interface GroupsPageProps {
  readonly onProjectChange: (project: WebProject) => void;
  readonly pipeline: PipelineState;
  readonly project: WebProject | null;
}

const ASPECTS: OutputSettings["aspect"][] = ["16:9", "9:16", "1:1"];
const RESOLUTIONS: OutputSettings["resolution"][] = ["720p", "1080p", "4k"];
const FPS_OPTIONS: OutputSettings["fps"][] = [24, 30, 60];

/** 한 그룹에 담을 수 있는 사진 수. 서버 검증과 같은 값을 쓴다. */
const MAX_PHOTOS_PER_GROUP = 6;

const EMPTY: GroupsResponse = {groups: [], mode: "auto", ungrouped: []};

const GENERATOR_LABEL: Record<NonNullable<GroupView["clip"]>["generator"], string> = {
  comfy: "ComfyUI",
  ffmpeg: "기본 생성",
  remotion: "Remotion",
};

const timeRange = (group: GroupView): string =>
  `${group.startAtLocal.slice(5, 16).replace("T", " ")} → ${group.endAtLocal.slice(11, 16)}`;

interface Selection {
  readonly groupIndex: number;
  readonly mediaId: string;
}

/** 화면에서 편집 중인 그룹 구성. 저장할 때 그대로 서버로 보낸다. */
interface Draft {
  mediaIds: string[];
  style: ClipStyle;
}

export const GroupsPage = ({onProjectChange, pipeline, project}: GroupsPageProps) => {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectId = project?.id ?? null;
  const sourceReady = isDone(project?.steps.fingerprint?.state);
  const built = isDone(project?.steps["group-clips"]?.state);

  const groupState = useRemoteData<GroupsResponse>(
    useCallback(
      () => (projectId === null ? Promise.resolve(EMPTY) : api.getGroups(projectId)),
      [projectId],
    ),
    `${projectId ?? "none"}:${project?.steps["group-clips"]?.state ?? ""}:${
      project?.steps.fingerprint?.state ?? ""
    }`,
  );
  const groups = groupState.data?.groups ?? EMPTY.groups;
  const mode = groupState.data?.mode ?? "auto";
  const ungrouped = groupState.data?.ungrouped ?? EMPTY.ungrouped;

  const comfyState = useRemoteData(
    useCallback(() => api.getComfyStatus(), []),
    "comfy-status",
  );
  const comfy = comfyState.data;

  /** 화면에서 고친 구성을 통째로 저장한다. 서버가 제목·시간·id 를 다시 계산한다. */
  const saveArrangement = async (next: readonly Draft[]): Promise<void> => {
    if (projectId === null) {
      return;
    }
    const payload = next
      .filter((group) => group.mediaIds.length > 0)
      .map((group) => ({mediaIds: [...group.mediaIds], style: group.style}));
    if (payload.length === 0) {
      setError("그룹을 최소 한 개 남겨야 합니다.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      groupState.set(await api.saveGroups(projectId, payload));
      setSelection(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  // 구성을 고쳐도 그룹마다 고른 움직임은 그대로 따라가야 한다.
  const arrangement = useMemo<Draft[]>(
    () => groups.map((group) => ({mediaIds: [...group.mediaIds], style: group.style})),
    [groups],
  );
  const cloneArrangement = (): Draft[] =>
    arrangement.map((group) => ({mediaIds: [...group.mediaIds], style: group.style}));

  const moveSelected = (direction: -1 | 1): void => {
    if (selection === null) {
      return;
    }
    const targetIndex = selection.groupIndex + direction;
    const next = cloneArrangement();
    const source = next[selection.groupIndex]!;
    source.mediaIds = source.mediaIds.filter((id) => id !== selection.mediaId);
    if (targetIndex < 0 || targetIndex >= next.length) {
      // 양 끝에서 밀면 새 그룹을 만든다. 움직임은 원래 그룹의 것을 물려받는다.
      const created: Draft = {mediaIds: [selection.mediaId], style: source.style};
      void saveArrangement(direction === -1 ? [created, ...next] : [...next, created]);
      return;
    }
    if (next[targetIndex]!.mediaIds.length >= MAX_PHOTOS_PER_GROUP) {
      setError(`한 그룹에는 사진을 최대 ${String(MAX_PHOTOS_PER_GROUP)}장까지 넣을 수 있습니다.`);
      return;
    }
    next[targetIndex]!.mediaIds = [...next[targetIndex]!.mediaIds, selection.mediaId];
    void saveArrangement(next);
  };

  const splitAtSelected = (): void => {
    if (selection === null) {
      return;
    }
    const source = arrangement[selection.groupIndex];
    const cut = source?.mediaIds.indexOf(selection.mediaId) ?? -1;
    if (source === undefined || cut <= 0) {
      setError("첫 번째 사진에서는 나눌 수 없습니다. 두 번째 이후 사진을 고르세요.");
      return;
    }
    const next = cloneArrangement();
    next.splice(
      selection.groupIndex,
      1,
      {mediaIds: source.mediaIds.slice(0, cut), style: source.style},
      {mediaIds: source.mediaIds.slice(cut), style: source.style},
    );
    void saveArrangement(next);
  };

  /** 고른 사진을 그룹에서 빼낸다. 그 사진은 클립에 들어가지 않고 아래 목록으로 내려간다. */
  const excludeSelected = (): void => {
    if (selection === null) {
      return;
    }
    const next = cloneArrangement();
    next[selection.groupIndex]!.mediaIds = next[selection.groupIndex]!.mediaIds.filter(
      (id) => id !== selection.mediaId,
    );
    void saveArrangement(next);
  };

  const addUngrouped = (mediaId: string, groupIndex: number): void => {
    const next = cloneArrangement();
    const target = next[groupIndex];
    if (target === undefined) {
      return;
    }
    if (target.mediaIds.length >= MAX_PHOTOS_PER_GROUP) {
      setError(`한 그룹에는 사진을 최대 ${String(MAX_PHOTOS_PER_GROUP)}장까지 넣을 수 있습니다.`);
      return;
    }
    target.mediaIds = [...target.mediaIds, mediaId];
    void saveArrangement(next);
  };

  const setStyle = async (groupId: string, style: ClipStyle): Promise<void> => {
    if (projectId === null) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      groupState.set(await api.setGroupStyle(projectId, groupId, style));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const resetToAuto = async (): Promise<void> => {
    if (projectId === null) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      groupState.set(await api.resetGroups(projectId));
      setSelection(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const saveOutput = async (patch: Partial<OutputSettings>): Promise<void> => {
    if (project === null) {
      return;
    }
    onProjectChange(
      await api.saveOutput(project.id, {
        aspect: patch.aspect ?? project.aspect,
        fps: patch.fps ?? project.fps,
        resolution: patch.resolution ?? project.resolution,
        style: patch.style ?? project.style,
      }),
    );
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

  return (
    <>
      <PageHead
        actions={
          <>
            {mode === "manual" ? (
              <button
                className="btn btn-ghost"
                disabled={saving || pipeline.busy}
                onClick={() => void resetToAuto()}
                type="button"
              >
                자동으로 되돌리기
              </button>
            ) : null}
            <button
              className="btn btn-primary"
              disabled={pipeline.busy || !sourceReady}
              onClick={() => void pipeline.run("group-clips", {force: false})}
              type="button"
            >
              {built ? "클립 다시 만들기" : "그룹 클립 만들기"}
            </button>
          </>
        }
        eyebrow="2단계"
        lede="비슷한 시각·장소에 찍은 사진을 자동으로 묶습니다. 마음에 들지 않으면 사진을 눌러 직접 옮기거나 나눌 수 있습니다."
        title="사진 그룹 → 영상 클립"
      />

      <div className="stack">
        <section className="panel">
          <div className="panel-head">
            <h2>출력 규격</h2>
            <span className="faint" style={{fontSize: 12}}>
              클립과 최종 영상에 똑같이 적용됩니다
            </span>
          </div>
          <div className="row wrap" style={{gap: 20}}>
            <label className="field">
              <span>화면 비율</span>
              <div className="seg">
                {ASPECTS.map((aspect) => (
                  <button
                    aria-pressed={project.aspect === aspect}
                    key={aspect}
                    onClick={() => void saveOutput({aspect})}
                    type="button"
                  >
                    {aspect}
                  </button>
                ))}
              </div>
            </label>
            <label className="field">
              <span>해상도</span>
              <div className="seg">
                {RESOLUTIONS.map((resolution) => (
                  <button
                    aria-pressed={project.resolution === resolution}
                    key={resolution}
                    onClick={() => void saveOutput({resolution})}
                    type="button"
                  >
                    {resolution}
                  </button>
                ))}
              </div>
            </label>
            <label className="field">
              <span>초당 프레임</span>
              <div className="seg">
                {FPS_OPTIONS.map((fps) => (
                  <button
                    aria-pressed={project.fps === fps}
                    key={fps}
                    onClick={() => void saveOutput({fps})}
                    type="button"
                  >
                    {fps}
                  </button>
                ))}
              </div>
            </label>
          </div>
          <p className="panel-note" style={{marginTop: 14}}>
            {comfy?.available === true
              ? `ComfyUI(${comfy.baseUrl ?? ""})로 생성합니다. 실패하면 자동으로 기본 방식으로 만듭니다.`
              : "ComfyUI가 연결되지 않아 기본 방식(카메라 움직임 + 교차 전환)으로 클립을 만듭니다."}
          </p>
        </section>

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
            body="원본 불러오기를 먼저 끝내야 사진을 그룹으로 묶을 수 있습니다."
            title="원본 준비가 필요합니다"
          />
        ) : groups.length === 0 ? (
          <EmptyState
            body="그룹으로 묶을 사진이 없습니다. 소스 화면에서 사진을 모두 제외하지 않았는지 확인하세요."
            title="아직 그룹이 없습니다"
          />
        ) : (
          <>
            <div className="stat-row">
              <div className="stat">
                <div className="stat-value">{groups.length}</div>
                <div className="stat-label">그룹</div>
              </div>
              <div className="stat">
                <div className="stat-value">
                  {groups.reduce((sum, group) => sum + group.mediaIds.length, 0)}
                </div>
                <div className="stat-label">사용된 사진</div>
              </div>
              <div className="stat">
                <div className="stat-value">
                  {groups.filter((group) => group.clip !== null).length}
                </div>
                <div className="stat-label">만들어진 클립</div>
              </div>
              <div className="stat">
                <div className="stat-value">{mode === "manual" ? "수동" : "자동"}</div>
                <div className="stat-label">묶는 방식</div>
              </div>
            </div>

            <div className="notice">
              사진을 클릭해 고른 뒤 <b>◀ 앞 그룹 / 뒤 그룹 ▶</b> 으로 옮기거나, <b>여기서 나누기</b>
              로 그룹을 둘로 가를 수 있습니다. 직접 고치면 다음부터 자동 묶기가 이 구성을 덮어쓰지
              않습니다.
            </div>

            <div className="group-list">
              {groups.map((group, groupIndex) => (
                <article className="group-card group-card-editable" key={group.id}>
                  <div className="group-strip">
                    {group.mediaIds.map((mediaId, index) => {
                      const active =
                        selection?.groupIndex === groupIndex && selection.mediaId === mediaId;
                      return (
                        <button
                          className="group-photo"
                          data-active={active}
                          key={mediaId}
                          onClick={() => setSelection(active ? null : {groupIndex, mediaId})}
                          title={group.photoNames[index] ?? mediaId}
                          type="button"
                        >
                          <ViewportImage alt="" src={group.photoThumbs[index] ?? null} />
                        </button>
                      );
                    })}
                  </div>
                  <div>
                    <div className="group-title">{group.title}</div>
                    <div className="group-meta">
                      사진 {group.mediaIds.length}장 · {timeRange(group)}
                      {group.source === "user" ? " · 직접 고침" : ""}
                      {group.clip === null
                        ? ""
                        : ` · ${group.clip.durationSec.toFixed(1)}초 · ${
                            GENERATOR_LABEL[group.clip.generator]
                          } · ${CLIP_STYLE_LABELS[group.clip.style]}`}
                      {group.clip !== null && group.clip.style !== group.style
                        ? " · 새 움직임 적용 대기"
                        : ""}
                    </div>
                    <div className="row wrap" style={{gap: 6, marginTop: 8}}>
                      {selection?.groupIndex === groupIndex ? (
                        <>
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={saving}
                            onClick={() => moveSelected(-1)}
                            type="button"
                          >
                            ◀ 앞 그룹
                          </button>
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={saving}
                            onClick={() => moveSelected(1)}
                            type="button"
                          >
                            뒤 그룹 ▶
                          </button>
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={saving}
                            onClick={() => splitAtSelected()}
                            type="button"
                          >
                            여기서 나누기
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            disabled={saving}
                            onClick={() => excludeSelected()}
                            type="button"
                          >
                            클립에서 제외
                          </button>
                        </>
                      ) : null}
                    </div>

                    <div className="row wrap" style={{gap: 6, marginTop: 10}}>
                      <span className="faint" style={{fontSize: 12}}>
                        움직임
                      </span>
                      <div className="seg">
                        {CLIP_STYLE_VALUES.map((style) => (
                          <button
                            aria-pressed={group.style === style}
                            disabled={saving || pipeline.busy}
                            key={style}
                            onClick={() => void setStyle(group.id, style)}
                            title={CLIP_STYLE_DESCRIPTIONS[style]}
                            type="button"
                          >
                            {CLIP_STYLE_LABELS[style]}
                          </button>
                        ))}
                      </div>
                      <button
                        className="btn btn-sm"
                        disabled={saving || pipeline.busy}
                        onClick={() =>
                          void pipeline.run("group-clips", {force: true, groupIds: [group.id]})
                        }
                        type="button"
                      >
                        이 클립만 다시 만들기
                      </button>
                    </div>
                  </div>
                  {group.clip === null ? (
                    <span className="pill">클립 없음</span>
                  ) : (
                    <video
                      className="clip-preview"
                      controls
                      muted
                      playsInline
                      preload="none"
                      src={`/assets/${group.clip.assetKey
                        .split("/")
                        .map((part) => encodeURIComponent(part))
                        .join("/")}`}
                    />
                  )}
                </article>
              ))}
            </div>

            {ungrouped.length === 0 ? null : (
              <section className="panel">
                <div className="panel-head">
                  <h2>그룹에 없는 사진</h2>
                  <span className="faint" style={{fontSize: 12}}>
                    클릭하면 마지막 그룹에 넣습니다
                  </span>
                </div>
                <div className="media-grid">
                  {ungrouped.map((photo) => (
                    <button
                      className="media-cell"
                      disabled={saving}
                      key={photo.id}
                      onClick={() => addUngrouped(photo.id, groups.length - 1)}
                      title={photo.filename}
                      type="button"
                    >
                      <ViewportImage alt={photo.filename} src={photo.thumbUrl} />
                    </button>
                  ))}
                </div>
              </section>
            )}

            {built ? (
              <div className="btn-row">
                <Link className="btn btn-primary" to="/video-clips">
                  다음 · 영상에서 클립 만들기
                </Link>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
};
