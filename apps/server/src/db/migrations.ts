import type BetterSqlite3 from "better-sqlite3";

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly version: number;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "bootstrap",
    sql: `
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 2,
    name: "media-index",
    sql: `
      CREATE TABLE IF NOT EXISTS media (
        source_root TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        id TEXT NOT NULL,
        filename TEXT NOT NULL,
        ext TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        media_type TEXT NOT NULL,
        captured_at_local TEXT NOT NULL,
        utc_offset_min INTEGER,
        time_source TEXT NOT NULL,
        status TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (source_root, relative_path)
      );

      CREATE INDEX IF NOT EXISTS idx_media_id ON media(id);
      CREATE INDEX IF NOT EXISTS idx_media_captured_at_local ON media(source_root, captured_at_local);
    `,
  },
  {
    version: 3,
    name: "job-runner",
    sql: `
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL,
        current_step TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS steps (
        job_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        code_version INTEGER NOT NULL,
        input_hash TEXT NOT NULL,
        params_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        progress REAL NOT NULL DEFAULT 0,
        message TEXT,
        error TEXT,
        output_ref TEXT,
        PRIMARY KEY (job_id, step_name),
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS cache (
        cache_key TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        output_ref TEXT,
        output_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_project_updated ON jobs(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_steps_state ON steps(job_id, state);
      CREATE INDEX IF NOT EXISTS idx_cache_project_step ON cache(project_id, step_name);
    `,
  },
  {
    version: 4,
    name: "web-projects",
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        utc_offset_min INTEGER NOT NULL,
        video_shift_min INTEGER NOT NULL DEFAULT 0,
        time_confirmed INTEGER NOT NULL DEFAULT 0,
        scan_statistics_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);
    `,
  },
  {
    version: 5,
    name: "admin-settings-and-curation",
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_curation (
        project_id TEXT PRIMARY KEY,
        order_json TEXT NOT NULL,
        global_look TEXT NOT NULL,
        item_looks_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 6,
    name: "storyboard-confirmation",
    sql: `
      ALTER TABLE projects ADD COLUMN storyboard_confirmed INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 7,
    name: "timeline-confirmation",
    sql: `
      ALTER TABLE projects ADD COLUMN timeline_confirmed INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 8,
    name: "music-confirmation",
    sql: `
      ALTER TABLE projects ADD COLUMN music_confirmed INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 9,
    name: "render-confirmation",
    sql: `
      ALTER TABLE projects ADD COLUMN render_confirmed INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 10,
    name: "video-folders",
    sql: `
      ALTER TABLE projects ADD COLUMN video_folder_path TEXT;
      ALTER TABLE projects ADD COLUMN video_output_path TEXT;

      CREATE TABLE IF NOT EXISTS video_analyses (
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        source_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        analysis_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, source_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_video_analyses_project ON video_analyses(project_id);
    `,
  },
  {
    version: 11,
    name: "project-output-settings",
    sql: `
      ALTER TABLE projects ADD COLUMN output_aspect TEXT NOT NULL DEFAULT '16:9';
      ALTER TABLE projects ADD COLUMN output_resolution TEXT NOT NULL DEFAULT '1080p';
      ALTER TABLE projects ADD COLUMN output_fps INTEGER NOT NULL DEFAULT 30;
      ALTER TABLE projects ADD COLUMN output_style TEXT NOT NULL DEFAULT 'cinematic-travel';

      DROP TABLE IF EXISTS project_curation;
      DROP TABLE IF EXISTS video_analyses;
    `,
  },
];

export interface MigrationResult {
  readonly applied: number;
  readonly currentVersion: number;
}

export const runMigrations = (database: BetterSqlite3.Database): MigrationResult => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedVersions = new Set(
    (
      database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
        version: number;
      }>
    ).map(({version}) => version),
  );

  let applied = 0;
  const applyMigration = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    database
      .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(migration.version, migration.name);
  });

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    applyMigration(migration);
    applied += 1;
  }

  const latest = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as {version: number};

  return {applied, currentVersion: latest.version};
};
