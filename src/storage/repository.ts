import type { Database } from "bun:sqlite";
import { DEFAULT_POSTPROCESS_PLAN, DEFAULT_SETTINGS } from "../domain/defaults";
import type {
  AppSettings,
  AuthProfile,
  ConflictStrategy,
  CreateAuthProfileInput,
  CreateRulesetInput,
  DaemonEvent,
  DownloadAttemptRecord,
  DownloadDetails,
  DownloadRecord,
  DownloadSegmentRecord,
  DownloadStatus,
  DownloadView,
  HostCapability,
  PostProcessJob,
  PostProcessPlan,
  Ruleset,
  SettingsRecord,
} from "../domain/types";
import { createId } from "../lib/ids";
import { parseJson, stringifyJson } from "../lib/json";
import { nowIso } from "../lib/time";

type DbDownloadRow = {
  id: string;
  status: DownloadStatus;
  url: string;
  source_text: string;
  destination_dir: string;
  target_filename: string;
  temp_path: string;
  final_path: string;
  mime_type: string | null;
  total_bytes: number | null;
  downloaded_bytes: number;
  resumable: number;
  strategy: "single" | "segmented";
  etag: string | null;
  last_modified: string | null;
  content_disposition: string | null;
  error_code: string | null;
  error_message: string | null;
  ruleset_id: string | null;
  auth_profile_id: string | null;
  headers_json: string;
  tags_json: string;
  checksum_json: string | null;
  postprocess_json: string;
  max_segments: number | null;
  rate_limit_bytes_per_sec: number | null;
  conflict_strategy: ConflictStrategy;
  retries: number;
  host: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type DbSegmentRow = {
  id: string;
  download_id: string;
  segment_index: number;
  start_byte: number;
  end_byte: number | null;
  downloaded_bytes: number;
  status: DownloadSegmentRecord["status"];
  created_at: string;
  updated_at: string;
};

type DbAttemptRow = {
  id: string;
  download_id: string;
  attempt: number;
  reason: string;
  status: DownloadAttemptRecord["status"];
  message: string | null;
  created_at: string;
};

type DbPostProcessJobRow = {
  id: string;
  download_id: string;
  step: PostProcessJob["step"];
  status: PostProcessJob["status"];
  message: string | null;
  created_at: string;
  updated_at: string;
};

export class Repository {
  constructor(private readonly db: Database) {}

  listDownloads(): DownloadRecord[] {
    return this.db
      .query<DbDownloadRow, []>("SELECT * FROM downloads ORDER BY created_at DESC")
      .all()
      .map(mapDownloadRecord);
  }

  listActiveDownloads(): DownloadRecord[] {
    return this.db
      .query<DbDownloadRow, []>(
        "SELECT * FROM downloads WHERE status NOT IN ('completed', 'failed', 'canceled') ORDER BY created_at DESC",
      )
      .all()
      .map(mapDownloadRecord);
  }

  listHistory(): DownloadRecord[] {
    return this.db
      .query<DbDownloadRow, []>(
        "SELECT * FROM downloads WHERE status IN ('completed', 'failed', 'canceled') ORDER BY updated_at DESC",
      )
      .all()
      .map(mapDownloadRecord);
  }

  getDownload(id: string): DownloadRecord | null {
    const row = this.db.query<DbDownloadRow, [string]>("SELECT * FROM downloads WHERE id = ?").get(id);
    return row ? mapDownloadRecord(row) : null;
  }

  createDownload(download: DownloadRecord): void {
    this.db
      .query(
        `
        INSERT INTO downloads (
          id, status, url, source_text, destination_dir, target_filename, temp_path, final_path,
          mime_type, total_bytes, downloaded_bytes, resumable, strategy, etag, last_modified,
          content_disposition, error_code, error_message, ruleset_id, auth_profile_id,
          headers_json, tags_json, checksum_json, postprocess_json, max_segments,
          rate_limit_bytes_per_sec, conflict_strategy, retries, host, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        download.id,
        download.status,
        download.url,
        download.sourceText,
        download.destinationDir,
        download.targetFilename,
        download.tempPath,
        download.finalPath,
        download.mimeType,
        download.totalBytes,
        download.downloadedBytes,
        Number(download.resumable),
        download.strategy,
        download.etag,
        download.lastModified,
        download.contentDisposition,
        download.errorCode,
        download.errorMessage,
        download.rulesetId,
        download.authProfileId,
        download.headersJson,
        download.tagsJson,
        download.checksumJson,
        download.postprocessJson,
        download.maxSegments,
        download.rateLimitBytesPerSec,
        download.conflictStrategy,
        download.retries,
        download.host,
        download.createdAt,
        download.updatedAt,
        download.completedAt,
      );
  }

  updateDownload(id: string, patch: Partial<DownloadRecord>): DownloadRecord {
    const current = this.getDownload(id);
    if (!current) {
      throw new Error(`Download ${id} not found`);
    }

    const next: DownloadRecord = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? nowIso(),
    };

    this.db
      .query(
        `
        UPDATE downloads
        SET status = ?, destination_dir = ?, target_filename = ?, temp_path = ?, final_path = ?,
            mime_type = ?, total_bytes = ?, downloaded_bytes = ?, resumable = ?, strategy = ?,
            etag = ?, last_modified = ?, content_disposition = ?, error_code = ?, error_message = ?,
            ruleset_id = ?, auth_profile_id = ?, headers_json = ?, tags_json = ?, checksum_json = ?,
            postprocess_json = ?, max_segments = ?, rate_limit_bytes_per_sec = ?, conflict_strategy = ?, retries = ?,
            updated_at = ?, completed_at = ?
        WHERE id = ?
      `,
      )
      .run(
        next.status,
        next.destinationDir,
        next.targetFilename,
        next.tempPath,
        next.finalPath,
        next.mimeType,
        next.totalBytes,
        next.downloadedBytes,
        Number(next.resumable),
        next.strategy,
        next.etag,
        next.lastModified,
        next.contentDisposition,
        next.errorCode,
        next.errorMessage,
        next.rulesetId,
        next.authProfileId,
        next.headersJson,
        next.tagsJson,
        next.checksumJson,
        next.postprocessJson,
        next.maxSegments,
        next.rateLimitBytesPerSec,
        next.conflictStrategy,
        next.retries,
        next.updatedAt,
        next.completedAt,
        next.id,
      );

    return next;
  }

  deleteDownload(id: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM download_segments WHERE download_id = ?").run(id);
      this.db.query("DELETE FROM download_attempts WHERE download_id = ?").run(id);
      this.db.query("DELETE FROM postprocess_jobs WHERE download_id = ?").run(id);
      this.db.query("DELETE FROM downloads WHERE id = ?").run(id);
    })();
  }

  replaceSegments(downloadId: string, segments: DownloadSegmentRecord[]): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM download_segments WHERE download_id = ?").run(downloadId);
      const statement = this.db.query(
        `
          INSERT INTO download_segments (
            id, download_id, segment_index, start_byte, end_byte, downloaded_bytes, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      for (const segment of segments) {
        statement.run(
          segment.id,
          segment.downloadId,
          segment.segmentIndex,
          segment.startByte,
          segment.endByte,
          segment.downloadedBytes,
          segment.status,
          segment.createdAt,
          segment.updatedAt,
        );
      }
    })();
  }

  updateSegment(segmentId: string, patch: Partial<DownloadSegmentRecord>): void {
    const current = this.db
      .query<DbSegmentRow, [string]>("SELECT * FROM download_segments WHERE id = ?")
      .get(segmentId);
    if (!current) {
      return;
    }
    const next = { ...mapSegmentRecord(current), ...patch, updatedAt: nowIso() };
    this.db
      .query(
        `
        UPDATE download_segments
        SET start_byte = ?, end_byte = ?, downloaded_bytes = ?, status = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(next.startByte, next.endByte, next.downloadedBytes, next.status, next.updatedAt, next.id);
  }

  listSegments(downloadId: string): DownloadSegmentRecord[] {
    return this.db
      .query<DbSegmentRow, [string]>(
        "SELECT * FROM download_segments WHERE download_id = ? ORDER BY segment_index ASC",
      )
      .all(downloadId)
      .map(mapSegmentRecord);
  }

  addAttempt(downloadId: string, reason: string, status: DownloadAttemptRecord["status"], message?: string): void {
    const attemptNumber = this.db
      .query<{ count: number }, [string]>("SELECT COUNT(*) as count FROM download_attempts WHERE download_id = ?")
      .get(downloadId)?.count;
    this.db
      .query(
        `
        INSERT INTO download_attempts (id, download_id, attempt, reason, status, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(createId("attempt"), downloadId, (attemptNumber ?? 0) + 1, reason, status, message ?? null, nowIso());
  }

  listAttempts(downloadId: string): DownloadAttemptRecord[] {
    return this.db
      .query<DbAttemptRow, [string]>(
        "SELECT * FROM download_attempts WHERE download_id = ? ORDER BY created_at DESC",
      )
      .all(downloadId)
      .map(mapAttemptRecord);
  }

  createPostProcessJobs(downloadId: string, steps: PostProcessJob["step"][]): PostProcessJob[] {
    const now = nowIso();
    const jobs = steps.map<PostProcessJob>((step) => ({
      id: createId("postprocess"),
      downloadId,
      step,
      status: "queued",
      message: null,
      createdAt: now,
      updatedAt: now,
    }));
    const insert = this.db.query(
      `
        INSERT INTO postprocess_jobs (id, download_id, step, status, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    );
    this.db.transaction(() => {
      this.db.query("DELETE FROM postprocess_jobs WHERE download_id = ?").run(downloadId);
      for (const job of jobs) {
        insert.run(job.id, job.downloadId, job.step, job.status, job.message, job.createdAt, job.updatedAt);
      }
    })();
    return jobs;
  }

  updatePostProcessJob(jobId: string, patch: Partial<PostProcessJob>): void {
    const current = this.db
      .query<DbPostProcessJobRow, [string]>("SELECT * FROM postprocess_jobs WHERE id = ?")
      .get(jobId);
    if (!current) {
      return;
    }
    const next: PostProcessJob = {
      id: current.id,
      downloadId: current.download_id,
      step: current.step,
      status: current.status,
      message: current.message,
      createdAt: current.created_at,
      ...patch,
      updatedAt: patch.updatedAt ?? nowIso(),
    };
    this.db
      .query(
        `
          UPDATE postprocess_jobs
          SET step = ?, status = ?, message = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(next.step, next.status, next.message, next.updatedAt, next.id);
  }

  listPostProcessJobs(downloadId: string): PostProcessJob[] {
    return this.db
      .query<DbPostProcessJobRow, [string]>(
        "SELECT * FROM postprocess_jobs WHERE download_id = ? ORDER BY created_at ASC",
      )
      .all(downloadId)
      .map((row) => ({
        id: row.id,
        downloadId: row.download_id,
        step: row.step,
        status: row.status,
        message: row.message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  addEvent(event: DaemonEvent): void {
    this.db
      .query("INSERT INTO download_events (id, type, download_id, timestamp, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run(event.id, event.type, event.downloadId, event.timestamp, stringifyJson(event.payload));
  }

  listEvents(limit = 200): DaemonEvent[] {
    return this.db
      .query<{ id: string; type: string; download_id: string | null; timestamp: string; payload_json: string }, [number]>(
        "SELECT * FROM download_events ORDER BY timestamp DESC LIMIT ?",
      )
      .all(limit)
      .map((row) => ({
        id: row.id,
        type: row.type,
        downloadId: row.download_id,
        timestamp: row.timestamp,
        payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      }))
      .reverse();
  }

  createAuthProfile(input: CreateAuthProfileInput): AuthProfile {
    const profile: AuthProfile = {
      id: createId("auth"),
      name: input.name,
      headers: input.headers,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.db
      .query("INSERT INTO auth_profiles (id, name, headers_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(profile.id, profile.name, stringifyJson(profile.headers), profile.createdAt, profile.updatedAt);
    return profile;
  }

  updateAuthProfile(id: string, patch: Partial<CreateAuthProfileInput>): AuthProfile {
    const current = this.getAuthProfile(id);
    if (!current) {
      throw new Error(`Auth profile ${id} not found`);
    }
    const next: AuthProfile = {
      ...current,
      ...patch,
      headers: patch.headers ?? current.headers,
      updatedAt: nowIso(),
    };
    this.db
      .query("UPDATE auth_profiles SET name = ?, headers_json = ?, updated_at = ? WHERE id = ?")
      .run(next.name, stringifyJson(next.headers), next.updatedAt, id);
    return next;
  }

  deleteAuthProfile(id: string): void {
    this.db.query("DELETE FROM auth_profiles WHERE id = ?").run(id);
  }

  listAuthProfiles(): AuthProfile[] {
    return this.db
      .query<{ id: string; name: string; headers_json: string; created_at: string; updated_at: string }, []>(
        "SELECT * FROM auth_profiles ORDER BY name ASC",
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        headers: parseJson<Record<string, string>>(row.headers_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  getAuthProfile(id: string): AuthProfile | null {
    const row = this.db
      .query<{ id: string; name: string; headers_json: string; created_at: string; updated_at: string }, [string]>(
        "SELECT * FROM auth_profiles WHERE id = ?",
      )
      .get(id);
    return row
      ? {
          id: row.id,
          name: row.name,
          headers: parseJson<Record<string, string>>(row.headers_json, {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  createRuleset(input: CreateRulesetInput): Ruleset {
    const ruleset: Ruleset = {
      id: createId("ruleset"),
      name: input.name,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 100,
      matchers: input.matchers ?? [],
      actions: input.actions ?? [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.db.transaction(() => {
      this.db
        .query("INSERT INTO rulesets (id, name, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          ruleset.id,
          ruleset.name,
          Number(ruleset.enabled),
          ruleset.priority,
          ruleset.createdAt,
          ruleset.updatedAt,
        );
      this.replaceRulesetParts(ruleset);
    })();

    return ruleset;
  }

  updateRuleset(id: string, patch: Partial<CreateRulesetInput & Pick<Ruleset, "enabled" | "priority">>): Ruleset {
    const current = this.getRuleset(id);
    if (!current) {
      throw new Error(`Ruleset ${id} not found`);
    }
    const next: Ruleset = {
      ...current,
      ...patch,
      enabled: patch.enabled ?? current.enabled,
      priority: patch.priority ?? current.priority,
      matchers: patch.matchers ?? current.matchers,
      actions: patch.actions ?? current.actions,
      updatedAt: nowIso(),
    };
    this.db.transaction(() => {
      this.db
        .query("UPDATE rulesets SET name = ?, enabled = ?, priority = ?, updated_at = ? WHERE id = ?")
        .run(next.name, Number(next.enabled), next.priority, next.updatedAt, id);
      this.replaceRulesetParts(next);
    })();
    return next;
  }

  deleteRuleset(id: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM ruleset_matchers WHERE ruleset_id = ?").run(id);
      this.db.query("DELETE FROM ruleset_actions WHERE ruleset_id = ?").run(id);
      this.db.query("DELETE FROM rulesets WHERE id = ?").run(id);
    })();
  }

  listRulesets(): Ruleset[] {
    const baseRows = this.db
      .query<{ id: string; name: string; enabled: number; priority: number; created_at: string; updated_at: string }, []>(
        "SELECT * FROM rulesets ORDER BY priority ASC, name ASC",
      )
      .all();
    return baseRows.map((row) => this.inflateRuleset(row));
  }

  getRuleset(id: string): Ruleset | null {
    const row = this.db
      .query<{ id: string; name: string; enabled: number; priority: number; created_at: string; updated_at: string }, [string]>(
        "SELECT * FROM rulesets WHERE id = ?",
      )
      .get(id);
    return row ? this.inflateRuleset(row) : null;
  }

  getSettings(): AppSettings {
    const rows = this.db
      .query<{ key: string; value_json: string; updated_at: string }, []>("SELECT * FROM settings")
      .all();
    const overrides = Object.fromEntries(rows.map((row) => [row.key, parseJson(row.value_json, null)]));
    return { ...DEFAULT_SETTINGS, ...overrides };
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    const now = nowIso();
    const statement = this.db.query(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    );
    for (const [key, value] of Object.entries(patch)) {
      statement.run(key, stringifyJson(value), now);
    }
    return this.getSettings();
  }

  listSettingsRows(): SettingsRecord[] {
    return this.db
      .query<{ key: string; value_json: string; updated_at: string }, []>("SELECT * FROM settings ORDER BY key ASC")
      .all()
      .map((row) => ({
        key: row.key,
        valueJson: row.value_json,
        updatedAt: row.updated_at,
      }));
  }

  getHostCapability(host: string): HostCapability | null {
    const row = this.db
      .query<{ host: string; supports_ranges: number; failures: number; last_checked_at: string }, [string]>(
        "SELECT * FROM host_capabilities WHERE host = ?",
      )
      .get(host);
    return row
      ? {
          host: row.host,
          supportsRanges: Boolean(row.supports_ranges),
          failures: row.failures,
          lastCheckedAt: row.last_checked_at,
        }
      : null;
  }

  setHostCapability(capability: HostCapability): void {
    this.db
      .query(
        `
        INSERT INTO host_capabilities (host, supports_ranges, failures, last_checked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET
          supports_ranges = excluded.supports_ranges,
          failures = excluded.failures,
          last_checked_at = excluded.last_checked_at
      `,
      )
      .run(
        capability.host,
        Number(capability.supportsRanges),
        capability.failures,
        capability.lastCheckedAt,
      );
  }

  getDownloadDetails(id: string): DownloadDetails | null {
    const download = this.getDownload(id);
    if (!download) {
      return null;
    }
    return {
      download,
      segments: this.listSegments(id),
      attempts: this.listAttempts(id),
      postprocessJobs: this.listPostProcessJobs(id),
      resolvedHeaders: parseJson<Record<string, string>>(download.headersJson, {}),
      parsedChecksum: parseJson(download.checksumJson, null),
      postprocessPlan: parseJson<PostProcessPlan>(download.postprocessJson, DEFAULT_POSTPROCESS_PLAN),
    };
  }

  toView(download: DownloadRecord, speedBytesPerSec = 0): DownloadView {
    const remaining =
      download.totalBytes != null ? Math.max(0, download.totalBytes - download.downloadedBytes) : null;
    const etaSeconds = speedBytesPerSec > 0 && remaining != null ? remaining / speedBytesPerSec : null;

    return {
      id: download.id,
      status: download.status,
      url: download.url,
      fileName: download.targetFilename,
      destinationDir: download.destinationDir,
      totalBytes: download.totalBytes,
      downloadedBytes: download.downloadedBytes,
      resumable: download.resumable,
      strategy: download.strategy,
      speedBytesPerSec,
      etaSeconds,
      retries: download.retries,
      host: download.host,
      mimeType: download.mimeType,
      errorMessage: download.errorMessage,
      createdAt: download.createdAt,
      updatedAt: download.updatedAt,
      completedAt: download.completedAt,
    };
  }

  private replaceRulesetParts(ruleset: Ruleset): void {
    this.db.query("DELETE FROM ruleset_matchers WHERE ruleset_id = ?").run(ruleset.id);
    this.db.query("DELETE FROM ruleset_actions WHERE ruleset_id = ?").run(ruleset.id);

    const matcherInsert = this.db.query(
      "INSERT INTO ruleset_matchers (id, ruleset_id, matcher_json) VALUES (?, ?, ?)",
    );
    const actionInsert = this.db.query(
      "INSERT INTO ruleset_actions (id, ruleset_id, action_json) VALUES (?, ?, ?)",
    );

    for (const matcher of ruleset.matchers) {
      matcherInsert.run(createId("matcher"), ruleset.id, stringifyJson(matcher));
    }
    for (const action of ruleset.actions) {
      actionInsert.run(createId("action"), ruleset.id, stringifyJson(action));
    }
  }

  private inflateRuleset(row: {
    id: string;
    name: string;
    enabled: number;
    priority: number;
    created_at: string;
    updated_at: string;
  }): Ruleset {
    const matchers = this.db
      .query<{ matcher_json: string }, [string]>("SELECT matcher_json FROM ruleset_matchers WHERE ruleset_id = ?")
      .all(row.id)
      .map((item) => parseJson<Ruleset["matchers"][number] | null>(item.matcher_json, null))
      .filter((item): item is Ruleset["matchers"][number] => item !== null);
    const actions = this.db
      .query<{ action_json: string }, [string]>("SELECT action_json FROM ruleset_actions WHERE ruleset_id = ?")
      .all(row.id)
      .map((item) => parseJson<Ruleset["actions"][number] | null>(item.action_json, null))
      .filter((item): item is Ruleset["actions"][number] => item !== null);

    return {
      id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
      priority: row.priority,
      matchers,
      actions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function mapDownloadRecord(row: DbDownloadRow): DownloadRecord {
  return {
    id: row.id,
    status: row.status,
    url: row.url,
    sourceText: row.source_text,
    destinationDir: row.destination_dir,
    targetFilename: row.target_filename,
    tempPath: row.temp_path,
    finalPath: row.final_path,
    mimeType: row.mime_type,
    totalBytes: row.total_bytes,
    downloadedBytes: row.downloaded_bytes,
    resumable: Boolean(row.resumable),
    strategy: row.strategy,
    etag: row.etag,
    lastModified: row.last_modified,
    contentDisposition: row.content_disposition,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    rulesetId: row.ruleset_id,
    authProfileId: row.auth_profile_id,
    headersJson: row.headers_json,
    tagsJson: row.tags_json,
    checksumJson: row.checksum_json,
    postprocessJson: row.postprocess_json,
    maxSegments: row.max_segments,
    rateLimitBytesPerSec: row.rate_limit_bytes_per_sec,
    conflictStrategy: row.conflict_strategy,
    retries: row.retries,
    host: row.host,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapSegmentRecord(row: DbSegmentRow): DownloadSegmentRecord {
  return {
    id: row.id,
    downloadId: row.download_id,
    segmentIndex: row.segment_index,
    startByte: row.start_byte,
    endByte: row.end_byte,
    downloadedBytes: row.downloaded_bytes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttemptRecord(row: DbAttemptRow): DownloadAttemptRecord {
  return {
    id: row.id,
    downloadId: row.download_id,
    attempt: row.attempt,
    reason: row.reason,
    status: row.status,
    message: row.message,
    createdAt: row.created_at,
  };
}
