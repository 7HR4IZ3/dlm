export type DownloadStatus =
  | "queued"
  | "probing"
  | "waiting_for_schedule"
  | "downloading"
  | "paused"
  | "postprocessing"
  | "completed"
  | "failed"
  | "canceled"
  | "restart_required";

export type IntakeKind = "url" | "curl" | "fetch" | "har";
export type DownloadStrategy = "single" | "segmented";
export type SegmentStatus = "pending" | "active" | "done" | "failed";
export type PostProcessStep = "verify" | "organize" | "extract" | "notify";
export type ChecksumAlgorithm = "sha256" | "sha512" | "md5";
export type ConflictStrategy = "auto-rename" | "overwrite" | "skip";

export interface AddDownloadInput {
  source: string;
  intakeKind?: IntakeKind | "auto";
  destinationDir?: string;
  filename?: string;
  headers?: Record<string, string>;
  authProfileId?: string;
  rulesetId?: string | null;
  tags?: string[];
  checksum?: {
    algorithm: ChecksumAlgorithm;
    value: string;
  } | null;
  postprocess?: {
    verify?: boolean;
    organize?: boolean;
    extract?: boolean;
    notify?: boolean;
    openFile?: boolean;
    openFolder?: boolean;
  };
  maxSegments?: number | null;
  rateLimitBytesPerSec?: number | null;
  startPaused?: boolean;
  conflictStrategy?: ConflictStrategy;
}

export interface ParsedIntake {
  kind: IntakeKind;
  url: string;
  method: string;
  headers: Record<string, string>;
  filenameHint?: string | null;
  warnings: string[];
}

export interface ParsedIntakeBatch {
  kind: IntakeKind;
  items: ParsedIntake[];
  warnings: string[];
}

export interface DownloadRecord {
  id: string;
  status: DownloadStatus;
  url: string;
  sourceText: string;
  destinationDir: string;
  targetFilename: string;
  tempPath: string;
  finalPath: string;
  mimeType: string | null;
  totalBytes: number | null;
  downloadedBytes: number;
  resumable: boolean;
  strategy: DownloadStrategy;
  etag: string | null;
  lastModified: string | null;
  contentDisposition: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  rulesetId: string | null;
  authProfileId: string | null;
  headersJson: string;
  tagsJson: string;
  checksumJson: string | null;
  postprocessJson: string;
  maxSegments: number | null;
  rateLimitBytesPerSec: number | null;
  conflictStrategy: ConflictStrategy;
  retries: number;
  host: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface DownloadSegmentRecord {
  id: string;
  downloadId: string;
  segmentIndex: number;
  startByte: number;
  endByte: number | null;
  downloadedBytes: number;
  status: SegmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DownloadAttemptRecord {
  id: string;
  downloadId: string;
  attempt: number;
  reason: string;
  status: "running" | "failed" | "succeeded";
  message: string | null;
  createdAt: string;
}

export interface HostCapability {
  host: string;
  supportsRanges: boolean;
  failures: number;
  lastCheckedAt: string;
}

export interface Ruleset {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchers: RulesetMatcher[];
  actions: RulesetAction[];
  createdAt: string;
  updatedAt: string;
}

export type RulesetMatcher =
  | { type: "host"; value: string }
  | { type: "url_glob"; value: string }
  | { type: "url_regex"; value: string }
  | { type: "mime"; value: string }
  | { type: "extension"; value: string }
  | { type: "min_size"; value: number }
  | { type: "max_size"; value: number }
  | { type: "tag"; value: string };

export type RulesetAction =
  | { type: "set_destination_dir"; value: string }
  | { type: "set_category"; value: string }
  | { type: "set_filename_template"; value: string }
  | { type: "set_max_segments"; value: number }
  | { type: "set_rate_limit"; value: number }
  | { type: "set_retry_policy"; value: string }
  | { type: "set_schedule_window"; value: string }
  | { type: "set_auth_profile"; value: string }
  | { type: "toggle_postprocess"; step: PostProcessStep; enabled: boolean };

export interface AuthProfile {
  id: string;
  name: string;
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface SettingsRecord {
  key: string;
  valueJson: string;
  updatedAt: string;
}

export interface DaemonEvent {
  id: string;
  type: string;
  downloadId: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface DownloadView {
  id: string;
  status: DownloadStatus;
  url: string;
  fileName: string;
  destinationDir: string;
  totalBytes: number | null;
  downloadedBytes: number;
  resumable: boolean;
  strategy: DownloadStrategy;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  retries: number;
  host: string;
  mimeType: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface PostProcessPlan {
  verify: boolean;
  organize: boolean;
  extract: boolean;
  notify: boolean;
  openFile: boolean;
  openFolder: boolean;
}

export interface DownloadDetails {
  download: DownloadRecord;
  segments: DownloadSegmentRecord[];
  attempts: DownloadAttemptRecord[];
  postprocessJobs: PostProcessJob[];
  resolvedHeaders: Record<string, string>;
  parsedChecksum:
    | {
        algorithm: ChecksumAlgorithm;
        value: string;
      }
    | null;
  postprocessPlan: PostProcessPlan;
}

export interface AppSettings {
  defaultDownloadDir: string;
  globalConcurrency: number;
  perHostConcurrency: number;
  globalRateLimitBytesPerSec: number | null;
  clipboardWatcherEnabled: boolean;
  quietHours: string | null;
  notifyOnComplete: boolean;
}

export interface PostProcessJob {
  id: string;
  downloadId: string;
  step: PostProcessStep;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRulesetInput {
  name: string;
  enabled?: boolean;
  priority?: number;
  matchers?: RulesetMatcher[];
  actions?: RulesetAction[];
}

export interface CreateAuthProfileInput {
  name: string;
  headers: Record<string, string>;
}
