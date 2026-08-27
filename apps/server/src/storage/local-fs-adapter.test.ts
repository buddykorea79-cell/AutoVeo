import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {Readable} from "node:stream";

import {afterEach, describe, expect, it} from "vitest";

import {LocalFsAdapter} from "./local-fs-adapter.js";

const temporaryDirectories: string[] = [];

const makeAdapter = async (): Promise<{adapter: LocalFsAdapter; root: string}> => {
  const root = await mkdtemp(path.join(tmpdir(), "travel-movie-storage-"));
  temporaryDirectories.push(root);
  return {adapter: new LocalFsAdapter(root), root};
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, {recursive: true})),
  );
});

describe("LocalFsAdapter", () => {
  it("writes buffers and streams atomically", async () => {
    const {adapter, root} = await makeAdapter();

    await adapter.write("nested/buffer.txt", Buffer.from("buffer-data"));
    await adapter.write("nested/stream.txt", Readable.from(["stream-", "data"]));

    await expect(adapter.read("nested/buffer.txt")).resolves.toEqual(Buffer.from("buffer-data"));
    await expect(readFile(path.join(root, "nested", "stream.txt"), "utf8")).resolves.toBe(
      "stream-data",
    );
    await expect(adapter.exists("nested/missing.txt")).resolves.toBe(false);
    expect(adapter.publicUrl("nested/한글 photo.jpg")).toBe(
      "/assets/nested/%ED%95%9C%EA%B8%80%20photo.jpg",
    );
  });

  it("rejects keys outside the storage root", async () => {
    const {adapter} = await makeAdapter();

    await expect(adapter.localPath("../outside.txt")).rejects.toThrow("escapes");
    await expect(adapter.localPath(path.resolve("outside.txt"))).rejects.toThrow("relative");
  });
});
