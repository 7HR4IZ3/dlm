import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { MAX_RETRIES, MAX_SEGMENTS_DEFAULT, SEGMENT_THRESHOLD_BYTES } from "../domain/defaults";
import type {
  AppSettings,
  DaemonEvent,
  DownloadDetails,
  DownloadRecord,
  DownloadSegmentRecord,
  HostCapability,
  Ruleset,
} from "../domain/types";
import { ensureDir, fileExists, resolveConflictPath } from "../lib/filesystem";
import { createId } from "../lib/ids";
import { parseJson } from "../lib/json";
import { redactHeaders } from "../lib/redact";
import { sleep } from "../lib/time";
import { isWithinSchedule } from "../rules/engine";
import { runPostProcess } from "../postprocess/pipeline";
import type { Repository } from "../storage/repository";

export interface TaskControl {
  repo: Repository;
  publish: (event: DaemonEvent) => void;
  createEvent: (type: string, payload: Record<string, unknown>, downloadId?: string | null) => DaemonEvent;
  logger: { info(message: string, context?: unknown): void; warn(message: string, context?: unknown): void; error(message: string, context?: unknown): void };
  getSettings: () => AppSettings;
  getRuleset: (id: string | null) => Ruleset | null;
  signalForDownload: (downloadId: string) => AbortSignal;
  clearSignal: (downloadId: string) => void;
  setSpeed: (downloadId: string, speedBytesPerSec: number) => void;
  getHostCapability: (host: string) => HostCapability | null;
  setHostCapability: (capability: HostCapability) => void;
}

export async function runDownloadTask(control: TaskControl, record: DownloadRecord): Promise<void> {
  const headers = parseJson<Record<string, string>>(record.headersJson, {});
  control.logger.info("Starting download", { id: record.id, url: record.url, headers: redactHeaders(headers) });

  try {
    const ruleset = control.getRuleset(record.rulesetId);
    if (!isDownloadAllowedNow(ruleset, control.getSettings())) {
      control.repo.updateDownload(record.id, { status: "waiting_for_schedule", errorMessage: null, errorCode: null });
      return;
    }

    control.repo.updateDownload(record.id, { status: "probing", errorMessage: null, errorCode: null });
    publish(control, "download.probing", record.id, { url: record.url });
    const metadata = await probeDownload(
      record,
      headers,
      control.signalForDownload(record.id),
      control.getHostCapability(record.host),
    );
    const validatorMismatch = hasValidatorMismatch(record, metadata);
    if (validatorMismatch) {
      control.repo.updateDownload(record.id, {
        status: "restart_required",
        errorCode: "validator_mismatch",
        errorMessage: validatorMismatch,
      });
      publish(control, "download.restart_required", record.id, { reason: validatorMismatch });
      return;
    }
    if (record.downloadedBytes > 0 && !metadata.resumable) {
      control.repo.updateDownload(record.id, {
        status: "restart_required",
        errorCode: "resume_unsupported",
        errorMessage: "Server no longer supports resumable download.",
      });
      publish(control, "download.restart_required", record.id, { reason: "resume_unsupported" });
      return;
    }
    control.repo.updateDownload(record.id, {
      status: "downloading",
      totalBytes: metadata.totalBytes,
      mimeType: metadata.mimeType,
      etag: metadata.etag,
      lastModified: metadata.lastModified,
      contentDisposition: metadata.contentDisposition,
      resumable: metadata.resumable,
      strategy: metadata.strategy,
    });
    control.setHostCapability({
      host: record.host,
      supportsRanges: metadata.resumable,
      failures: control.getHostCapability(record.host)?.failures ?? 0,
      lastCheckedAt: new Date().toISOString(),
    });

    const updated = control.repo.getDownload(record.id);
    if (!updated) {
      return;
    }

    let finalPath: string;
    if (metadata.strategy === "segmented") {
      finalPath = await runSegmented(control, updated, headers, metadata.totalBytes ?? 0);
    } else {
      finalPath = await runSingleStream(control, updated, headers);
    }
    control.repo.updateDownload(record.id, { finalPath });

    const completed = control.repo.getDownload(record.id);
    if (!completed || completed.status === "paused" || completed.status === "canceled") {
      return;
    }

    const details = control.repo.getDownloadDetails(record.id);
    if (!details) {
      return;
    }
    await finalizeDownload(control, details);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = control.repo.getDownload(record.id);
    if (!current) {
      return;
    }

    if (current.status === "paused" || current.status === "canceled") {
      return;
    }

    const aborted = message.includes("aborted") || message.includes("AbortError");
    if (aborted) {
      return;
    }

    if (error instanceof ScheduleWindowClosedError) {
      return;
    }

    const nextRetries = current.retries + 1;
    control.repo.addAttempt(record.id, "download", "failed", message);
    if (nextRetries <= MAX_RETRIES && isTransientError(message)) {
      control.repo.updateDownload(record.id, {
        status: "queued",
        retries: nextRetries,
        errorCode: "retry_scheduled",
        errorMessage: message,
      });
      publish(control, "download.retry_scheduled", record.id, { retries: nextRetries, message });
      await sleep(Math.min(15000, 1000 * 2 ** nextRetries));
    } else {
      control.repo.updateDownload(record.id, {
        status: "failed",
        retries: nextRetries,
        errorCode: "download_failed",
        errorMessage: message,
      });
      publish(control, "download.failed", record.id, { message });
    }
  } finally {
    control.setSpeed(record.id, 0);
    control.clearSignal(record.id);
  }
}

async function finalizeDownload(control: TaskControl, details: DownloadDetails): Promise<void> {
  control.repo.updateDownload(details.download.id, { status: "postprocessing" });
  const steps = (Object.entries(details.postprocessPlan) as Array<[keyof typeof details.postprocessPlan, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .filter((key): key is "verify" | "organize" | "extract" | "notify" =>
      key === "verify" || key === "organize" || key === "extract" || key === "notify",
    );
  const jobs = control.repo.createPostProcessJobs(details.download.id, steps);
  publish(control, "download.postprocess_started", details.download.id, { steps });
  for (const job of jobs) {
    control.repo.updatePostProcessJob(job.id, { status: "running" });
  }
  const checksum = details.parsedChecksum;
  let result;
  try {
    result = await runPostProcess({
      download: details.download,
      postprocessPlan: details.postprocessPlan,
      checksum,
      notifyOnComplete: control.getSettings().notifyOnComplete,
    });
    for (const job of jobs) {
      control.repo.updatePostProcessJob(job.id, {
        status: result.completedSteps.includes(job.step) ? "completed" : "skipped",
        message: result.messages.join(" ").trim() || null,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const job of jobs) {
      control.repo.updatePostProcessJob(job.id, { status: "failed", message });
    }
    publish(control, "download.postprocess_failed", details.download.id, { message });
    throw error;
  }
  const completedAt = new Date().toISOString();
  control.repo.updateDownload(details.download.id, {
    status: "completed",
    finalPath: result.finalPath,
    completedAt,
    updatedAt: completedAt,
    errorCode: null,
    errorMessage: result.messages.join(" ").trim() || null,
  });
  publish(control, "download.completed", details.download.id, {
    path: result.finalPath,
    steps: result.completedSteps,
    messages: result.messages,
  });
}

async function runSingleStream(
  control: TaskControl,
  record: DownloadRecord,
  headers: Record<string, string>,
): Promise<string> {
  await ensureDir(record.destinationDir);
  const start = record.resumable ? record.downloadedBytes : 0;
  const requestHeaders = new Headers(headers);
  if (start > 0) {
    requestHeaders.set("Range", `bytes=${start}-`);
  }

  const signal = control.signalForDownload(record.id);
  const response = await fetch(record.url, { headers: requestHeaders, signal });
  if (!response.ok && response.status !== 206) {
    throw new Error(`Download request failed with ${response.status}`);
  }

  const writer = await fs.open(record.tempPath, "a+");
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Empty response body.");
  }

  let offset = start;
  let progressSinceSample = 0;
  let sampleStart = Date.now();

  while (true) {
    signal.throwIfAborted();
    ensureScheduleStillOpen(control, record);
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    await writer.write(value, 0, value.length, offset);
    offset += value.length;
    progressSinceSample += value.length;
    control.repo.updateDownload(record.id, { downloadedBytes: offset, status: "downloading" });
    publish(control, "download.progress", record.id, {
      downloadedBytes: offset,
      totalBytes: record.totalBytes,
    });

    const elapsed = Date.now() - sampleStart;
    if (elapsed >= 1000) {
      control.setSpeed(record.id, Math.round((progressSinceSample / elapsed) * 1000));
      progressSinceSample = 0;
      sampleStart = Date.now();
    }

    const rateLimit = record.rateLimitBytesPerSec ?? control.getSettings().globalRateLimitBytesPerSec;
    if (rateLimit) {
      await sleep(Math.ceil((value.length / rateLimit) * 1000));
    }
  }

  await writer.close();
  return await moveIntoFinalLocation(record);
}

async function runSegmented(
  control: TaskControl,
  record: DownloadRecord,
  headers: Record<string, string>,
  totalBytes: number,
): Promise<string> {
  const maxSegments = Math.max(1, Math.min(record.maxSegments ?? MAX_SEGMENTS_DEFAULT, MAX_SEGMENTS_DEFAULT));
  const plannedSegments = planSegments(record.id, totalBytes, maxSegments);
  control.repo.replaceSegments(record.id, plannedSegments);

  await ensureDir(record.destinationDir);
  const handle = await fs.open(record.tempPath, "w+");
  await handle.truncate(totalBytes);
  await handle.close();

  const signal = control.signalForDownload(record.id);
  const progress = new Map<string, number>(plannedSegments.map((segment) => [segment.id, 0]));
  let lastSampleBytes = 0;
  let sampleStart = Date.now();

  try {
    await Promise.all(
      plannedSegments.map(async (segment) => {
        const segmentHeaders = new Headers(headers);
        const start = segment.startByte + segment.downloadedBytes;
        const end = segment.endByte ?? totalBytes - 1;
        segmentHeaders.set("Range", `bytes=${start}-${end}`);

        const response = await fetch(record.url, { headers: segmentHeaders, signal });
        if (response.status !== 206) {
          throw new RangeNotSupportedError(`Expected 206 for segment ${segment.segmentIndex}, got ${response.status}`);
        }
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("Empty segmented response body.");
        }
        const file = await fs.open(record.tempPath, "r+");
        let offset = start;
        while (true) {
          signal.throwIfAborted();
          ensureScheduleStillOpen(control, record);
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          await file.write(value, 0, value.length, offset);
          offset += value.length;
          const segmentBytes = offset - segment.startByte;
          progress.set(segment.id, segmentBytes);
          control.repo.updateSegment(segment.id, { downloadedBytes: segmentBytes, status: "active" });
          const totalDownloaded = Array.from(progress.values()).reduce((sum, current) => sum + current, 0);
          control.repo.updateDownload(record.id, { downloadedBytes: totalDownloaded });
          publish(control, "download.progress", record.id, {
            downloadedBytes: totalDownloaded,
            totalBytes,
            segmentIndex: segment.segmentIndex,
          });

          const elapsed = Date.now() - sampleStart;
          if (elapsed >= 1000) {
            control.setSpeed(record.id, Math.round(((totalDownloaded - lastSampleBytes) / elapsed) * 1000));
            lastSampleBytes = totalDownloaded;
            sampleStart = Date.now();
          }
        }
        await file.close();
        control.repo.updateSegment(segment.id, {
          downloadedBytes: (segment.endByte ?? totalBytes - 1) - segment.startByte + 1,
          status: "done",
        });
      }),
    );
  } catch (error) {
    if (error instanceof RangeNotSupportedError) {
      control.logger.warn("Falling back to single stream after range failure", { id: record.id, message: error.message });
      control.setHostCapability({
        host: record.host,
        supportsRanges: false,
        failures: (control.getHostCapability(record.host)?.failures ?? 0) + 1,
        lastCheckedAt: new Date().toISOString(),
      });
      await fs.rm(record.tempPath, { force: true });
      control.repo.replaceSegments(record.id, []);
      control.repo.updateDownload(record.id, {
        strategy: "single",
        resumable: false,
        downloadedBytes: 0,
      });
      const fresh = control.repo.getDownload(record.id);
      if (fresh) {
        return await runSingleStream(control, fresh, headers);
      }
      throw new Error("Unable to continue after range fallback.");
    }
    throw error;
  }

  return await moveIntoFinalLocation(record);
}

async function moveIntoFinalLocation(record: DownloadRecord): Promise<string> {
  const resolved = await resolveConflictPath(
    record.destinationDir,
    basename(record.finalPath),
    record.conflictStrategy,
  );
  if (!resolved) {
    throw new Error("Final destination already exists and conflict strategy is skip.");
  }
  await fs.rename(record.tempPath, resolved);
  return resolved;
}

export function canStartDownload(
  record: DownloadRecord,
  activeDownloads: DownloadRecord[],
  settings: AppSettings,
  ruleset: Ruleset | null,
): boolean {
  const queueable = record.status === "queued" || record.status === "waiting_for_schedule";
  if (!queueable) {
    return false;
  }
  if (!isDownloadAllowedNow(ruleset, settings)) {
      return false;
  }

  if (activeDownloads.length >= settings.globalConcurrency) {
    return false;
  }
  const activeForHost = activeDownloads.filter((download) => download.host === record.host).length;
  return activeForHost < settings.perHostConcurrency;
}

async function probeDownload(
  record: DownloadRecord,
  headers: Record<string, string>,
  signal: AbortSignal,
  capability: HostCapability | null,
): Promise<{
  totalBytes: number | null;
  mimeType: string | null;
  etag: string | null;
  lastModified: string | null;
  contentDisposition: string | null;
  resumable: boolean;
  strategy: "single" | "segmented";
}> {
  const requestHeaders = new Headers(headers);
  let head = await fetch(record.url, { method: "HEAD", headers: requestHeaders, signal }).catch(() => null);
  let resumable = false;
  let totalBytes = head ? headerToNumber(head.headers.get("content-length")) : null;

  if (!head || !head.ok || head.headers.get("accept-ranges") == null) {
    const rangeHeaders = new Headers(headers);
    rangeHeaders.set("Range", "bytes=0-0");
    const fallback = await fetch(record.url, { headers: rangeHeaders, signal });
    if (!fallback.ok && fallback.status !== 206) {
      throw new Error(`Probe failed with ${fallback.status}`);
    }
    head = fallback;
    totalBytes = parseContentRangeTotal(fallback.headers.get("content-range")) ?? totalBytes;
    resumable = fallback.status === 206;
  } else {
    resumable = /bytes/i.test(head.headers.get("accept-ranges") ?? "");
  }

  const canSegment =
    resumable &&
    (capability?.supportsRanges ?? true) &&
    (capability?.failures ?? 0) === 0 &&
    (totalBytes ?? 0) >= SEGMENT_THRESHOLD_BYTES;
  const strategy = canSegment ? "segmented" : "single";
  return {
    totalBytes,
    mimeType: head.headers.get("content-type"),
    etag: head.headers.get("etag"),
    lastModified: head.headers.get("last-modified"),
    contentDisposition: head.headers.get("content-disposition"),
    resumable,
    strategy,
  };
}

function planSegments(downloadId: string, totalBytes: number, maxSegments: number): DownloadSegmentRecord[] {
  const segmentSize = Math.ceil(totalBytes / maxSegments);
  const segments: DownloadSegmentRecord[] = [];
  const now = new Date().toISOString();
  for (let index = 0; index < maxSegments; index += 1) {
    const start = index * segmentSize;
    const end = Math.min(totalBytes - 1, start + segmentSize - 1);
    if (start > end) {
      break;
    }
    segments.push({
      id: createId("seg"),
      downloadId,
      segmentIndex: index,
      startByte: start,
      endByte: end,
      downloadedBytes: 0,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }
  return segments;
}

function publish(
  control: TaskControl,
  type: string,
  downloadId: string,
  payload: Record<string, unknown>,
): void {
  const event = control.createEvent(type, payload, downloadId);
  control.repo.addEvent(event);
  control.publish(event);
}

function parseContentRangeTotal(contentRange: string | null): number | null {
  if (!contentRange) {
    return null;
  }
  const match = contentRange.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function headerToNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTransientError(message: string): boolean {
  return /5\d{2}|timeout|network|reset|temporar/i.test(message);
}

class RangeNotSupportedError extends Error {}
class ScheduleWindowClosedError extends Error {}

function hasValidatorMismatch(
  record: DownloadRecord,
  metadata: {
    etag: string | null;
    lastModified: string | null;
  },
): string | null {
  if (record.downloadedBytes <= 0) {
    return null;
  }
  if (record.etag && metadata.etag && record.etag !== metadata.etag) {
    return "ETag changed since the last partial download.";
  }
  if (record.lastModified && metadata.lastModified && record.lastModified !== metadata.lastModified) {
    return "Last-Modified changed since the last partial download.";
  }
  return null;
}

function ensureScheduleStillOpen(control: TaskControl, record: DownloadRecord): void {
  const ruleset = control.getRuleset(record.rulesetId);
  if (!isDownloadAllowedNow(ruleset, control.getSettings())) {
    control.repo.updateDownload(record.id, {
      status: "waiting_for_schedule",
      errorCode: "waiting_for_schedule",
      errorMessage: "Download paused because it is outside the allowed schedule window.",
    });
    publish(control, "download.waiting_for_schedule", record.id, {});
    throw new ScheduleWindowClosedError("Schedule window closed.");
  }
}

export function isDownloadAllowedNow(ruleset: Ruleset | null, settings: AppSettings): boolean {
  const ruleWindow = ruleset?.actions.find((action) => action.type === "set_schedule_window")?.value ?? null;
  if (ruleWindow && !isWithinSchedule(ruleWindow)) {
    return false;
  }
  if (settings.quietHours && isWithinSchedule(settings.quietHours)) {
    return false;
  }
  return true;
}
