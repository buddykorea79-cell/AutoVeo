import {createHash} from "node:crypto";

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const hashStepParams = (params: unknown): string =>
  createHash("sha1").update(stableStringify(params)).digest("hex");

export const makeStepCacheKey = (
  stepName: string,
  codeVersion: number,
  inputHash: string,
  params: unknown,
): string =>
  createHash("sha1")
    .update([stepName, codeVersion, inputHash, stableStringify(params)].join("|"))
    .digest("hex");
