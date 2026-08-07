import type { AuthProfile, DaemonEvent, DownloadDetails, DownloadView, Ruleset } from "../domain/types";
import { formatDuration } from "../lib/time";
import { formatBytes, formatSpeed } from "../lib/units";

export function printDownloads(downloads: DownloadView[]): void {
  if (downloads.length === 0) {
    console.log("No downloads.");
    return;
  }

  for (const download of downloads) {
    console.log(
      `${download.id}  ${download.status.padEnd(18)}  ${download.fileName}  ${formatBytes(download.downloadedBytes)} / ${formatBytes(download.totalBytes)}  ${formatSpeed(download.speedBytesPerSec)}  ETA ${formatDuration(download.etaSeconds)}`,
    );
  }
}

export function printDownloadDetails(details: DownloadDetails): void {
  const { download } = details;
  console.log(`${download.id} ${download.status}`);
  console.log(download.url);
  console.log(`${download.targetFilename} -> ${download.finalPath}`);
  console.log(`Downloaded: ${formatBytes(download.downloadedBytes)} / ${formatBytes(download.totalBytes)}`);
  console.log(`Resumable: ${download.resumable}  Strategy: ${download.strategy}`);
  if (download.errorMessage) {
    console.log(`Error: ${download.errorMessage}`);
  }
  if (details.segments.length > 0) {
    console.log("Segments:");
    for (const segment of details.segments) {
      console.log(
        `  #${segment.segmentIndex} ${segment.status} ${segment.startByte}-${segment.endByte ?? "*"} ${formatBytes(segment.downloadedBytes)}`,
      );
    }
  }
}

export function printRulesets(rulesets: Ruleset[]): void {
  if (rulesets.length === 0) {
    console.log("No rulesets.");
    return;
  }
  for (const ruleset of rulesets) {
    console.log(`${ruleset.id} ${ruleset.enabled ? "enabled" : "disabled"} ${ruleset.name}`);
  }
}

export function printAuthProfiles(profiles: AuthProfile[]): void {
  if (profiles.length === 0) {
    console.log("No auth profiles.");
    return;
  }
  for (const profile of profiles) {
    console.log(`${profile.id} ${profile.name}`);
  }
}

export function printEvents(event: DaemonEvent): void {
  console.log(`${event.timestamp} ${event.type}${event.downloadId ? ` ${event.downloadId}` : ""}`);
}

