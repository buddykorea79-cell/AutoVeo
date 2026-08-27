import Database from "better-sqlite3";
import {afterEach, describe, expect, it} from "vitest";

import {runMigrations} from "./migrations.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("runMigrations", () => {
  it("applies each migration once", () => {
    const database = new Database(":memory:");
    databases.push(database);

    expect(runMigrations(database)).toEqual({applied: 11, currentVersion: 11});
    expect(runMigrations(database)).toEqual({applied: 0, currentVersion: 11});

    const rows = database.prepare("SELECT version, name FROM schema_migrations").all();
    expect(rows).toEqual([
      {version: 1, name: "bootstrap"},
      {version: 2, name: "media-index"},
      {version: 3, name: "job-runner"},
      {version: 4, name: "web-projects"},
      {version: 5, name: "admin-settings-and-curation"},
      {version: 6, name: "storyboard-confirmation"},
      {version: 7, name: "timeline-confirmation"},
      {version: 8, name: "music-confirmation"},
      {version: 9, name: "render-confirmation"},
      {version: 10, name: "video-folders"},
      {version: 11, name: "project-output-settings"},
    ]);
  });
});
