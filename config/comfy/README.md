# ComfyUI 이미지→영상 설정

## 1. ComfyUI에서 워크플로 준비

1. ComfyUI에서 이미지 한 장을 입력으로 받아 MP4를 출력하는 워크플로를 먼저 실행해 봅니다.
2. 일반 저장 파일이 아니라 **Save (API Format)**으로 JSON을 저장합니다.
3. JSON을 이 폴더 등에 둡니다.

```text
config/comfy/image-to-video-api.json
```

체크포인트와 커스텀 노드는 이 저장소에 복사하지 않고 ComfyUI 설치 폴더에서 관리합니다.

## 2. 워크플로에 플레이스홀더 넣기

앱은 실행 직전에 다음 문자열을 실제 값으로 치환합니다.

| 플레이스홀더              | 용도                                    | 필수 |
| ------------------------- | --------------------------------------- | ---- |
| `{{INPUT_IMAGE}}`         | ComfyUI에 업로드한 입력 이미지 파일명   | 예   |
| `{{PROMPT}}`              | Ollama 또는 사용자가 만든 양성 프롬프트 | 예   |
| `{{TARGET_FRAMES}}`       | 해당 segment의 정수 프레임 수           | 예   |
| `{{OUTPUT_PREFIX}}`       | 충돌하지 않는 출력 파일 접두사          | 예   |
| `{{NEGATIVE_PROMPT}}`     | 부정 프롬프트                           | 선택 |
| `{{SEED}}`                | 정수 시드                               | 선택 |
| `{{FPS}}`                 | 프로젝트 FPS                            | 선택 |
| `{{WIDTH}}`, `{{HEIGHT}}` | 프로젝트 출력 크기                      | 선택 |

예를 들어 Load Image 노드의 이미지 값은 `{{INPUT_IMAGE}}`, 프롬프트 노드의 text는
`{{PROMPT}}`, 비디오 저장 노드의 filename prefix는 `{{OUTPUT_PREFIX}}`로 바꿉니다.

## 3. 웹앱에서 연결

관리자 화면의 **ComfyUI 이미지→영상**에서 다음 값을 저장합니다.

```text
로컬 ComfyUI 주소: http://127.0.0.1:8188
API 워크플로 JSON 경로: config/comfy/image-to-video-api.json
```

보안을 위해 주소는 `localhost`, `127.0.0.1`, `::1`만 허용합니다. 저장 시 앱이 워크플로
JSON 구조와 필수 플레이스홀더를 검사하고 `/system_stats`로 로컬 ComfyUI 연결을 확인합니다.
서버 재시작은 필요하지 않습니다.

## 4. 출력 조건과 fallback

- 워크플로는 ComfyUI 출력 노드를 통해 MP4를 생성해야 합니다.
- 앱은 `/prompt`, `/history/{prompt_id}`, `/view` 순서로 결과를 가져옵니다.
- 생성 영상이 없거나 segment보다 짧거나 ffprobe 검증에 실패하면 해당 segment는 원래
  사진/몽타주로 안전하게 대체됩니다.
- 생성 결과와 입력 이미지는 원본 미디어를 수정하지 않습니다.
