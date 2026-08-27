import {useCallback, useEffect, useMemo, useRef, useState} from "react";

import {api} from "../api";
import type {PipelineStep, ProgressEvent, StepName, WebProject} from "../types";

export const isDone = (state: string | undefined): boolean =>
  state === "succeeded" || state === "cached";

export const isBusy = (state: string | undefined): boolean =>
  state === "running" || state === "pending" || state === "queued";

/** 서버가 첫 진행 이벤트를 보내기 전까지 화면에 띄울 단계 이름. */
const FIRST_STEP_OF: Record<PipelineStep, StepName> = {
  "analyze-clips": "analyze-clips",
  "detect-video-segments": "detect-video-segments",
  "extract-video-clips": "extract-video-clips",
  finalize: "finalize",
  "group-clips": "group-clips",
  import: "scan",
  music: "music",
  render: "render",
  timeline: "assemble",
};

export interface PipelineState {
  readonly busy: boolean;
  readonly error: string | null;
  readonly live: ProgressEvent | null;
  clearError: () => void;
  refresh: () => Promise<WebProject | null>;
  run: (step: PipelineStep, body?: Record<string, unknown>) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * 한 프로젝트의 단계 실행과 진행 상황을 한곳에서 다룬다.
 * 서버는 SSE 로 단계별 진행률을 보내고, 단계가 끝나면 프로젝트를 다시 읽는다.
 */
export const usePipeline = (
  project: WebProject | null,
  onProjectChange: (project: WebProject) => void,
  onStepFinished?: (step: StepName) => void,
): PipelineState => {
  const projectId = project?.id ?? null;
  const [live, setLive] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const finishedRef = useRef(onStepFinished);
  const changeRef = useRef(onProjectChange);

  useEffect(() => {
    finishedRef.current = onStepFinished;
    changeRef.current = onProjectChange;
  });

  const refresh = useCallback(async (): Promise<WebProject | null> => {
    if (projectId === null) {
      return null;
    }
    const next = await api.getProject(projectId);
    changeRef.current(next);
    return next;
  }, [projectId]);

  useEffect(() => {
    if (projectId === null) {
      return;
    }
    const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);

    const apply = (event: ProgressEvent): void => {
      if (event.state === "running" || event.state === "pending") {
        setLive(event);
        return;
      }
      if (event.state === "failed") {
        setLive(null);
        setError(event.message ?? "작업이 실패했습니다.");
        void refresh();
        return;
      }
      if (event.state === "cancelled") {
        setLive(null);
        void refresh();
        return;
      }
      if (event.state === "succeeded" || event.state === "cached") {
        setLive(null);
        finishedRef.current?.(event.step);
        void refresh();
      }
    };

    const onMessage = (message: MessageEvent<string>): void => {
      try {
        apply(JSON.parse(message.data) as ProgressEvent);
      } catch {
        // 형식이 어긋난 이벤트는 무시한다.
      }
    };
    const onSnapshot = (message: MessageEvent<string>): void => {
      try {
        const events = JSON.parse(message.data) as ProgressEvent[];
        const running = events.find(
          (event) => event.state === "running" || event.state === "pending",
        );
        setLive(running ?? null);
      } catch {
        // 무시한다.
      }
    };

    source.addEventListener("message", onMessage);
    source.addEventListener("snapshot", onSnapshot as EventListener);
    return () => {
      source.removeEventListener("message", onMessage);
      source.removeEventListener("snapshot", onSnapshot as EventListener);
      source.close();
    };
  }, [projectId, refresh]);

  const run = useCallback(
    async (step: PipelineStep, body: Record<string, unknown> = {}) => {
      if (projectId === null) {
        return;
      }
      setError(null);
      setStarting(true);
      setLive({
        etaSec: null,
        message: "시작하는 중",
        progress: 0,
        state: "running",
        step: FIRST_STEP_OF[step],
      });
      try {
        await api.runStep(projectId, step, body);
      } catch (caught) {
        setLive(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setStarting(false);
      }
    },
    [projectId],
  );

  const stop = useCallback(async () => {
    if (projectId === null) {
      return;
    }
    try {
      await api.cancelJobs(projectId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    setLive(null);
    await refresh();
  }, [projectId, refresh]);

  return useMemo(
    () => ({
      busy: starting || live !== null,
      clearError: () => setError(null),
      error,
      live,
      refresh,
      run,
      stop,
    }),
    [error, live, refresh, run, starting, stop],
  );
};
