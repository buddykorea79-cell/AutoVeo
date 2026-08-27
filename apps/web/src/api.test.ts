import {afterEach, describe, expect, it, vi} from "vitest";

import {api} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.selectFolder", () => {
  it("does not mark an empty POST request as JSON", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toBeInstanceOf(Headers);
      expect((init?.headers as Headers).has("Content-Type")).toBe(false);
      return new Response(JSON.stringify({folderPath: null}), {
        headers: {"Content-Type": "application/json"},
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.selectFolder()).resolves.toEqual({folderPath: null});
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
