import {useCallback, useEffect, useState} from "react";
import {NavLink, Navigate, Route, Routes} from "react-router-dom";

import {api} from "./api";
import {usePipeline} from "./hooks/usePipeline";
import {ClipsPage} from "./pages/ClipsPage";
import {FinishPage} from "./pages/FinishPage";
import {GroupsPage} from "./pages/GroupsPage";
import {SettingsPage} from "./pages/SettingsPage";
import {SourcePage} from "./pages/SourcePage";
import {VideoClipsPage} from "./pages/VideoClipsPage";
import {TimelinePage} from "./pages/TimelinePage";
import {isDone, type PipelineState} from "./hooks/usePipeline";
import type {StepName, WebProject} from "./types";

const STORAGE_KEY = "autoveo-project-id";

const STEPS = [
  {done: ["fingerprint"], label: "소스", path: "/source"},
  {done: ["group-clips"], label: "그룹", path: "/groups"},
  {done: ["extract-video-clips"], label: "영상", path: "/video-clips"},
  {done: ["analyze-clips"], label: "클립", path: "/clips"},
  {done: ["timeline"], label: "타임라인", path: "/timeline"},
  {done: ["finalize"], label: "완성", path: "/finish"},
] as const satisfies readonly {
  readonly done: readonly StepName[];
  readonly label: string;
  readonly path: string;
}[];

export const App = () => {
  const [project, setProject] = useState<WebProject | null>(null);
  const [savedId] = useState(() => window.localStorage.getItem(STORAGE_KEY));
  const [restoring, setRestoring] = useState(savedId !== null);

  useEffect(() => {
    if (savedId === null) {
      return;
    }
    api
      .getProject(savedId)
      .then(setProject)
      .catch(() => window.localStorage.removeItem(STORAGE_KEY))
      .finally(() => setRestoring(false));
  }, [savedId]);

  useEffect(() => {
    if (restoring) {
      return;
    }
    if (project === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, project.id);
    }
  }, [project, restoring]);

  const handleProjectChange = useCallback((next: WebProject) => setProject(next), []);
  const pipeline: PipelineState = usePipeline(project, handleProjectChange);

  if (restoring) {
    return <div className="app-loading">이전 작업을 불러오는 중…</div>;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink className="brand" to="/source">
          <span className="brand-mark">AV</span>
          <span>AutoVeo</span>
        </NavLink>
        <nav aria-label="제작 단계" className="steps">
          {STEPS.map((step, index) => {
            const complete = step.done.some((name) => isDone(project?.steps[name]?.state));
            return (
              <NavLink
                className={({isActive}) =>
                  [
                    "step-link",
                    isActive ? "step-link-active" : "",
                    complete ? "step-link-done" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                }
                key={step.path}
                to={step.path}
              >
                <span className="step-index">{complete ? "✓" : index + 1}</span>
                {step.label}
              </NavLink>
            );
          })}
        </nav>
        <div className="topbar-right">
          <NavLink
            className={({isActive}) => `btn btn-sm btn-ghost ${isActive ? "step-link-active" : ""}`}
            to="/settings"
          >
            설정
          </NavLink>
        </div>
      </header>

      <main>
        <Routes>
          <Route element={<Navigate replace to="/source" />} path="/" />
          <Route
            element={
              <SourcePage
                onProjectChange={setProject}
                onReset={() => setProject(null)}
                pipeline={pipeline}
                project={project}
              />
            }
            path="/source"
          />
          <Route
            element={
              <GroupsPage onProjectChange={setProject} pipeline={pipeline} project={project} />
            }
            path="/groups"
          />
          <Route
            element={<VideoClipsPage pipeline={pipeline} project={project} />}
            path="/video-clips"
          />
          <Route element={<ClipsPage pipeline={pipeline} project={project} />} path="/clips" />
          <Route
            element={<TimelinePage pipeline={pipeline} project={project} />}
            path="/timeline"
          />
          <Route element={<FinishPage pipeline={pipeline} project={project} />} path="/finish" />
          <Route element={<SettingsPage />} path="/settings" />
          <Route element={<Navigate replace to="/source" />} path="*" />
        </Routes>
      </main>
    </div>
  );
};
