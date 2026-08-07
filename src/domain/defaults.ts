import type { AppSettings, PostProcessPlan } from "./types";

export const DEFAULT_DOWNLOAD_DIR = `${process.env.HOME ?? "."}/Downloads`;

export const DEFAULT_SETTINGS: AppSettings = {
  defaultDownloadDir: DEFAULT_DOWNLOAD_DIR,
  globalConcurrency: 3,
  perHostConcurrency: 2,
  globalRateLimitBytesPerSec: null,
  clipboardWatcherEnabled: false,
  quietHours: null,
  notifyOnComplete: true,
};

export const DEFAULT_POSTPROCESS_PLAN: PostProcessPlan = {
  verify: false,
  organize: false,
  extract: false,
  notify: false,
  openFile: false,
  openFolder: false,
};

export const DEFAULT_CONFLICT_STRATEGY = "auto-rename";

export const SEGMENT_THRESHOLD_BYTES = 32 * 1024 * 1024;
export const MAX_SEGMENTS_DEFAULT = 4;
export const MAX_RETRIES = 5;
export const EVENT_HISTORY_LIMIT = 500;
