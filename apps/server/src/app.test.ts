import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import {afterEach, describe, expect, it} from "vitest";

import {buildApp} from "./app.js";
import {runMigrations} from "./db/migrations.js";
import {LocalFsAdapter} from "./storage/local-fs-adapter.js";

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    await cleanup();
  }
});

describe("GET /api/health", () => {
  it("reports healthy database and storage dependencies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-movie-health-"));
    const storageRoot = path.join(root, "work");
    await mkdir(storageRoot, {recursive: true});

    const database = new Database(":memory:");
    runMigrations(database);
    const app = buildApp({database, storage: new LocalFsAdapter(storageRoot)});

    cleanupTasks.push(() => rm(root, {recursive: true}));
    cleanupTasks.push(() => {
      database.close();
    });
    cleanupTasks.push(() => app.close());

    const response = await app.inject({method: "GET", url: "/api/health"});

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      checks: {database: "ok", storage: "ok"},
      service: "autoveo-server",
      status: "ok",
    });
  });
});

describe("local settings and folder selection", () => {
  it("saves defaults and returns the selected local folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-movie-settings-"));
    const storageRoot = path.join(root, "work");
    await mkdir(storageRoot, {recursive: true});
    const database = new Database(":memory:");
    runMigrations(database);
    const app = buildApp({
      database,
      folderPicker: {selectFolder: async () => root},
      storage: new LocalFsAdapter(storageRoot),
    });
    cleanupTasks.push(() => rm(root, {force: true, recursive: true}));
    cleanupTasks.push(() => {
      database.close();
    });
    cleanupTasks.push(() => app.close());

    const initial = await app.inject({method: "GET", url: "/api/admin/settings"});
    expect(initial.statusCode).toBe(200);
    const save = await app.inject({
      body: {
        defaultLook: "film",
        defaultUtcOffsetMin: 540,
        defaultVideoShiftMin: 60,
        lastFolderPath: root,
      },
      method: "PUT",
      url: "/api/admin/settings",
    });
    expect(save.statusCode).toBe(200);
    expect(save.json<{defaultLook: string}>().defaultLook).toBe("film");

    const selected = await app.inject({method: "POST", url: "/api/system/select-folder"});
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toEqual({folderPath: root});
  });
});
