import { basename, join } from "node:path";
import {
  DEFAULT_CONFLICT_STRATEGY,
  DEFAULT_DOWNLOAD_DIR,
  DEFAULT_POSTPROCESS_PLAN,
  MAX_SEGMENTS_DEFAULT,
} from "../domain/defaults";
import type { AddDownloadInput, AppSettings, AuthProfile, DownloadRecord, ParsedIntake, Ruleset } from "../domain/types";
import { sanitizeFilename } from "../lib/filesystem";
import { createId } from "../lib/ids";
import { stringifyJson } from "../lib/json";
import { nowIso } from "../lib/time";
import { resolveRules } from "../rules/engine";

export interface PlannedDownload {
  download: DownloadRecord;
  warnings: string[];
}

export function planDownload(
  input: AddDownloadInput,
  parsed: ParsedIntake,
  settings: AppSettings,
  rulesets: Ruleset[],
  authProfiles: AuthProfile[],
  tempRoot: string,
): PlannedDownload {
  const url = new URL(parsed.url);
  const host = url.host;
  const ruleResult = resolveRules(
    input,
    {
      url: parsed.url,
      host,
      fileName: input.filename ?? parsed.filenameHint ?? basename(url.pathname) ?? null,
      tags: input.tags ?? [],
    },
    rulesets,
    authProfiles,
  );

  const downloadId = createId("dl");
  const fallbackName = parsed.filenameHint ?? basename(url.pathname) ?? "download";
  const fileName = sanitizeFilename(
    input.filename ?? renderFilename(ruleResult.filenameTemplate, fallbackName),
  );
  const destinationDir = input.destinationDir ?? ruleResult.destinationDir ?? settings.defaultDownloadDir ?? DEFAULT_DOWNLOAD_DIR;
  const tempPath = join(tempRoot, `${downloadId}.part`);
  const finalPath = join(destinationDir, fileName);
  const authHeaders =
    authProfiles.find((profile) => profile.id === (input.authProfileId ?? ruleResult.authProfileId))?.headers ?? {};
  const headers = {
    ...authHeaders,
    ...parsed.headers,
    ...(input.headers ?? {}),
  };

  const now = nowIso();
  const postprocessPlan = {
    ...DEFAULT_POSTPROCESS_PLAN,
    ...ruleResult.postprocess,
    ...input.postprocess,
  };

  const initialStatus = input.startPaused
    ? "paused"
    : ruleResult.scheduleWindow
      ? "waiting_for_schedule"
      : "queued";

  return {
    warnings: parsed.warnings,
    download: {
      id: downloadId,
      status: initialStatus,
      url: parsed.url,
      sourceText: input.source,
      destinationDir,
      targetFilename: fileName,
      tempPath,
      finalPath,
      mimeType: null,
      totalBytes: null,
      downloadedBytes: 0,
      resumable: false,
      strategy: "single",
      etag: null,
      lastModified: null,
      contentDisposition: null,
      errorCode: null,
      errorMessage: null,
      rulesetId: input.rulesetId ?? ruleResult.matchedRulesets.at(0)?.id ?? null,
      authProfileId: input.authProfileId ?? ruleResult.authProfileId ?? null,
      headersJson: stringifyJson(headers),
      tagsJson: stringifyJson(input.tags ?? []),
      checksumJson: input.checksum ? stringifyJson(input.checksum) : null,
      postprocessJson: stringifyJson(postprocessPlan),
      maxSegments: input.maxSegments ?? ruleResult.maxSegments ?? MAX_SEGMENTS_DEFAULT,
      rateLimitBytesPerSec: input.rateLimitBytesPerSec ?? ruleResult.rateLimitBytesPerSec ?? null,
      conflictStrategy: input.conflictStrategy ?? DEFAULT_CONFLICT_STRATEGY,
      retries: 0,
      host,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    },
  };
}

function renderFilename(template: string | undefined, fallback: string): string {
  if (!template) {
    return fallback || "download";
  }
  return template.replace(/\{name\}/g, fallback || "download");
}
