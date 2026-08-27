import {useEffect, useState} from "react";

import {api} from "../api";
import {PageHead} from "../components/PageHead";
import type {AdminSettings, ComfyStatusResponse, OllamaModelsResponse} from "../types";

export const SettingsPage = () => {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [models, setModels] = useState<OllamaModelsResponse | null>(null);
  const [comfy, setComfy] = useState<ComfyStatusResponse | null>(null);
  const [ffmpeg, setFfmpeg] = useState<{available: boolean; error: string | null} | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getAdminSettings().then(setSettings);
    void api.getOllamaModels().then(setModels);
    void api.getComfyStatus().then(setComfy);
    void api.getFfmpegStatus().then(setFfmpeg);
  }, []);

  const save = async (next: AdminSettings): Promise<void> => {
    setError(null);
    try {
      setSettings(await api.saveAdminSettings(next));
      setMessage("저장했습니다.");
      window.setTimeout(() => setMessage(null), 2400);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const visionModels = (models?.models ?? []).filter((model) => model.vision);

  return (
    <>
      <PageHead
        eyebrow="설정"
        lede="AI 분석과 클립 생성에 쓰는 로컬 도구를 연결합니다. 셋 다 선택 사항이며, 없어도 파이프라인은 끝까지 돕니다."
        title="로컬 도구 연결"
      />

      <div className="stack">
        {error === null ? null : <div className="notice notice-bad">{error}</div>}

        <section className="panel">
          <div className="panel-head">
            <h2>FFmpeg</h2>
            <span className={`pill ${ffmpeg?.available === true ? "pill-good" : "pill-bad"}`}>
              {ffmpeg?.available === true ? "사용 가능" : "없음"}
            </span>
          </div>
          <p className="panel-note">
            {ffmpeg?.available === true
              ? "클립 생성, 프레임 추출, 최종 음악 합성에 사용합니다."
              : (ffmpeg?.error ??
                "FFmpeg를 찾지 못했습니다. .env의 FFMPEG_PATH / FFPROBE_PATH를 확인하세요.")}
          </p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Ollama 비전 모델</h2>
            <span className={`pill ${models?.available === true ? "pill-good" : "pill-warn"}`}>
              {models?.available === true ? "연결됨" : "연결 안 됨"}
            </span>
          </div>
          {models?.available === true ? (
            <div className="stack">
              <label className="field">
                <span>클립 분석 모델</span>
                <select
                  onChange={(event) => {
                    if (settings === null) {
                      return;
                    }
                    void save({
                      ...settings,
                      ollamaModel: event.target.value === "" ? null : event.target.value,
                    });
                  }}
                  value={settings?.ollamaModel ?? ""}
                >
                  <option value="">자동 선택</option>
                  {visionModels.map((model) => (
                    <option key={model.name} value={model.name}>
                      {model.name}
                      {model.parameterSize === null ? "" : ` · ${model.parameterSize}`}
                    </option>
                  ))}
                </select>
              </label>
              {visionModels.length === 0 ? (
                <div className="notice notice-warn">
                  이미지를 볼 수 있는 모델이 없습니다. 예:{" "}
                  <span className="mono">ollama pull qwen3-vl:4b</span>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="panel-note">
              {models?.error ??
                ".env에 OLLAMA_BASE_URL=http://127.0.0.1:11434 을 넣고 서버를 다시 시작하세요."}{" "}
              연결하지 않으면 화질·안정성만으로 클립 점수를 매기고 자막 초안은 만들지 않습니다.
            </p>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>ComfyUI (선택)</h2>
            <span className={`pill ${comfy?.available === true ? "pill-good" : "pill-warn"}`}>
              {comfy?.available === true ? "연결됨" : "연결 안 됨"}
            </span>
          </div>
          <div className="stack">
            <p className="panel-note">
              연결하면 사진 그룹을 이미지→영상 워크플로로 생성합니다. 실패하거나 연결하지 않으면
              카메라 움직임과 교차 전환으로 만든 기본 클립을 사용합니다.
            </p>
            <div className="grid-2">
              <label className="field">
                <span>ComfyUI 주소</span>
                <input
                  onChange={(event) =>
                    setSettings((current) =>
                      current === null
                        ? current
                        : {
                            ...current,
                            comfyBaseUrl:
                              event.target.value.trim() === "" ? null : event.target.value.trim(),
                          },
                    )
                  }
                  placeholder="http://127.0.0.1:8188"
                  type="text"
                  value={settings?.comfyBaseUrl ?? ""}
                />
              </label>
              <label className="field">
                <span>API 워크플로 JSON 경로</span>
                <input
                  onChange={(event) =>
                    setSettings((current) =>
                      current === null
                        ? current
                        : {
                            ...current,
                            comfyWorkflowPath:
                              event.target.value.trim() === "" ? null : event.target.value.trim(),
                          },
                    )
                  }
                  placeholder="config/comfy/image-to-video-api.json"
                  type="text"
                  value={settings?.comfyWorkflowPath ?? ""}
                />
              </label>
            </div>
            <div className="btn-row">
              <button
                className="btn btn-primary"
                disabled={settings === null}
                onClick={() => {
                  if (settings !== null) {
                    void save(settings);
                  }
                }}
                type="button"
              >
                저장
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => void api.getComfyStatus().then(setComfy)}
                type="button"
              >
                상태 다시 확인
              </button>
            </div>
            {comfy?.error === null || comfy?.error === undefined ? null : (
              <p className="panel-note">{comfy.error}</p>
            )}
          </div>
        </section>
      </div>

      {message === null ? null : <div className="toast">{message}</div>}
    </>
  );
};
