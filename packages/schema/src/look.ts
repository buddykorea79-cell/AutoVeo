import {z} from "zod";

/** 불러온 사진·영상에 입히는 색감 필터. 렌더 단계에서 한 번만 적용한다. */
export const lookPresetSchema = z.enum(["none", "bright", "warm", "cool", "mono", "film"]);
export type LookPreset = z.infer<typeof lookPresetSchema>;

export const LOOK_PRESET_VALUES = lookPresetSchema.options;

export interface LookAdjustment {
  readonly brightness: number;
  readonly contrast: number;
  readonly grayscale: number;
  readonly hueRotateDeg: number;
  readonly saturate: number;
  readonly sepia: number;
}

const NEUTRAL: LookAdjustment = {
  brightness: 1,
  contrast: 1,
  grayscale: 0,
  hueRotateDeg: 0,
  saturate: 1,
  sepia: 0,
};

/**
 * 화면 미리보기(웹)와 실제 렌더(Remotion)가 같은 숫자를 쓰도록 한곳에 둔다.
 * 값을 바꾸면 timeline 의 codeVersion 을 올려 캐시를 무효화해야 한다.
 */
export const LOOK_PRESETS: Readonly<Record<LookPreset, LookAdjustment>> = {
  bright: {
    brightness: 1.08,
    contrast: 1.06,
    grayscale: 0,
    hueRotateDeg: 0,
    saturate: 1.18,
    sepia: 0,
  },
  cool: {
    brightness: 1.02,
    contrast: 1.08,
    grayscale: 0,
    hueRotateDeg: 12,
    saturate: 1.05,
    sepia: 0,
  },
  film: {
    brightness: 1.02,
    contrast: 0.94,
    grayscale: 0,
    hueRotateDeg: 0,
    saturate: 0.85,
    sepia: 0.24,
  },
  mono: {brightness: 1.02, contrast: 1.12, grayscale: 1, hueRotateDeg: 0, saturate: 1, sepia: 0},
  none: NEUTRAL,
  warm: {
    brightness: 1.03,
    contrast: 1.04,
    grayscale: 0,
    hueRotateDeg: -6,
    saturate: 1.1,
    sepia: 0.18,
  },
};

export const LOOK_LABELS: Readonly<Record<LookPreset, string>> = {
  bright: "화사하게",
  cool: "시원하게",
  film: "필름",
  mono: "모노톤",
  none: "원본",
  warm: "따뜻하게",
};

/** 좁은 자리에 쓰는 한 글자 표시. 동그라미만으로는 필터를 구분하기 어렵다. */
export const LOOK_SHORT_LABELS: Readonly<Record<LookPreset, string>> = {
  bright: "화",
  cool: "시",
  film: "필",
  mono: "모",
  none: "원",
  warm: "따",
};

/** CSS `filter` 문자열. 조정할 것이 없으면 "none" 을 돌려준다. */
export const lookCssFilter = (look: LookPreset): string => {
  const adjustment = LOOK_PRESETS[look];
  const parts: string[] = [];
  if (adjustment.grayscale > 0) {
    parts.push(`grayscale(${adjustment.grayscale.toFixed(2)})`);
  }
  if (adjustment.sepia > 0) {
    parts.push(`sepia(${adjustment.sepia.toFixed(2)})`);
  }
  if (adjustment.saturate !== 1) {
    parts.push(`saturate(${adjustment.saturate.toFixed(2)})`);
  }
  if (adjustment.contrast !== 1) {
    parts.push(`contrast(${adjustment.contrast.toFixed(2)})`);
  }
  if (adjustment.brightness !== 1) {
    parts.push(`brightness(${adjustment.brightness.toFixed(2)})`);
  }
  if (adjustment.hueRotateDeg !== 0) {
    parts.push(`hue-rotate(${String(adjustment.hueRotateDeg)}deg)`);
  }
  return parts.length === 0 ? "none" : parts.join(" ");
};
