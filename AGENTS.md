# Repository working rules

모든 작업에 적용되는 규칙:

## 착수 전

1. repository 상태와 `AGENTS.md`를 먼저 읽는다.
2. 관련된 기존 코드를 먼저 조사한다. 중복 구현을 만들지 않는다.
3. 외부 환경(ffmpeg 필터, sharp 능력, chromium gl)을 추측하지 않는다. `docs/environment-report.md`를 참조하거나 직접 확인한다.

## 구현 중

4. 현재 단계에 필요하지 않은 기능을 미리 구현하지 않는다.
5. 새 abstraction을 만들기 전에 기존 구조로 해결 가능한지 확인한다.
6. 원본 미디어를 절대 수정하지 않는다. 읽기 전용으로만 연다.
7. 개인 경로, 포트, API 키를 소스에 하드코딩하지 않는다.
8. 프레임 계산은 `packages/core/layoutScenes` 밖에서 하지 않는다.
9. 초 단위 float을 누적하지 않는다.
10. 비싼 연산은 `(stepName, codeVersion, inputHash, params)` 키로 캐시한다. 로직을 바꾸면 `codeVersion`을 반드시 올린다.
11. 산출물은 임시 경로에 쓰고 성공 시에만 rename한다.
12. optional dependency가 없으면 graceful fallback을 제공한다.
13. Windows / macOS / Linux 경로를 모두 고려한다. `path.join`을 쓴다.
14. `caption.source === "user"`인 데이터를 어떤 경로로도 덮어쓰지 않는다.
15. `context.trackPartialOutput`은 단계가 끝나면 지워야 할 중간 파일에만 쓴다. 성공해도 지워지므로 산출물을 등록하면 안 된다.
16. 렌더는 `work/` 아래 우리가 만든 파일만 읽는다. 원본 경로를 렌더 계획에 넣지 않는다.
17. 원본 4K 영상에서 프레임을 반복해 뽑지 않는다. 시간축이 같은 프록시가 있으면 그것으로 분석한다.

## 완료 전

18. `pnpm lint && pnpm typecheck && pnpm test`를 실행한다.
19. 외부 프로그램을 쓰는 기능은 integration validation을 수행한다. ffmpeg/remotion 관련은 실제 파일을 만들어 ffprobe로 확인한다.
20. 실패한 테스트를 무시하고 완료 처리하지 않는다.
21. 임시 workaround보다 root cause를 해결한다.

## 완료 보고 형식

- 변경 사항
- 검증 결과 (실제 명령 출력 포함)
- 남은 문제
- 다음 권장 단계

## 금지

- "아마 동작할 것이다" 식 서술
- 검증 없이 완료 선언
- 요청하지 않은 리팩터링
