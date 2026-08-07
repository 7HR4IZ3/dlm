import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "../lib/filesystem";

const MIGRATIONS = [
  `
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      url TEXT NOT NULL,
      source_text TEXT NOT NULL,
      destination_dir TEXT NOT NULL,
      target_filename TEXT NOT NULL,
      temp_path TEXT NOT NULL,
      final_path TEXT NOT NULL,
      mime_type TEXT,
      total_bytes INTEGER,
      downloaded_bytes INTEGER NOT NULL DEFAULT 0,
      resumable INTEGER NOT NULL DEFAULT 0,
      strategy TEXT NOT NULL DEFAULT 'single',
      etag TEXT,
      last_modified TEXT,
      content_disposition TEXT,
      error_code TEXT,
      error_message TEXT,
      ruleset_id TEXT,
      auth_profile_id TEXT,
      headers_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      checksum_json TEXT,
      postprocess_json TEXT NOT NULL,
      max_segments INTEGER,
      rate_limit_bytes_per_sec INTEGER,
      retries INTEGER NOT NULL DEFAULT 0,
      host TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS download_segments (
      id TEXT PRIMARY KEY,
      download_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER,
      downloaded_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS download_attempts (
      id TEXT PRIMARY KEY,
      download_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS download_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      download_id TEXT,
      timestamp TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS auth_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      headers_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS rulesets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS ruleset_matchers (
      id TEXT PRIMARY KEY,
      ruleset_id TEXT NOT NULL,
      matcher_json TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS ruleset_actions (
      id TEXT PRIMARY KEY,
      ruleset_id TEXT NOT NULL,
      action_json TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS postprocess_jobs (
      id TEXT PRIMARY KEY,
      download_id TEXT NOT NULL,
      step TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS host_capabilities (
      host TEXT PRIMARY KEY,
      supports_ranges INTEGER NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE downloads ADD COLUMN conflict_strategy TEXT NOT NULL DEFAULT 'auto-rename';
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_downloads_status_created_at ON downloads(status, created_at);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_download_events_timestamp ON download_events(timestamp);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_postprocess_jobs_download_id ON postprocess_jobs(download_id);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_download_segments_download_id ON download_segments(download_id);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_download_attempts_download_id ON download_attempts(download_id);
  `,
];

export async function initDatabase(path: string): Promise<Database> {
  await ensureDir(dirname(path));
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = OFF;");
  applyMigrations(db);
  if (!existsSync(path)) {
    db.run("VACUUM;");
  }
  return db;
}

function applyMigrations(db: Database): void {
  db.exec(MIGRATIONS[0]!);
  for (let index = 0; index < MIGRATIONS.length; index += 1) {
    const migrationId = `m${index + 1}`;
    const alreadyApplied = db
      .query<{ id: string }, [string]>("SELECT id FROM migrations WHERE id = ?")
      .get(migrationId);
    if (alreadyApplied) {
      continue;
    }
    db.transaction(() => {
      db.exec(MIGRATIONS[index]!);
      db
        .query("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
        .run(migrationId, new Date().toISOString());
    })();
  }
}
