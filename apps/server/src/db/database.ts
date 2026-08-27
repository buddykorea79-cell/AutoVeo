import {mkdirSync} from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {runMigrations} from "./migrations.js";

export interface OpenDatabaseResult {
  readonly database: Database.Database;
  readonly migrationsApplied: number;
  readonly schemaVersion: number;
}

export const openDatabase = (databasePath: string): OpenDatabaseResult => {
  mkdirSync(path.dirname(databasePath), {recursive: true});

  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  const journalMode = database.pragma("journal_mode = WAL", {simple: true}) as string;
  if (String(journalMode).toLowerCase() !== "wal") {
    console.warn(
      `SQLite journal_mode WAL not available, got ${String(journalMode)} - performance may degrade`,
    );
  }
  // Checkpoint to prevent unbounded WAL growth
  try {
    database.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // Best effort: old SQLite may not support truncate mode
    try {
      database.pragma("wal_checkpoint(RESTART)");
    } catch {
      // Ignore checkpoint failures at startup
    }
  }

  const result = runMigrations(database);

  return {
    database,
    migrationsApplied: result.applied,
    schemaVersion: result.currentVersion,
  };
};
