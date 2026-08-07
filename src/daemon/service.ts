import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AppPaths } from "../lib/paths";
import { ensureAppPaths } from "../lib/paths";
import type { Logger } from "../lib/logger";
import { EventHub } from "./events";
import { Repository } from "../storage/repository";
import { initDatabase } from "../storage/database";
import type {
  AddDownloadInput,
  AppSettings,
  AuthProfile,
  CreateAuthProfileInput,
  CreateRulesetInput,
  DaemonEvent,
  DownloadDetails,
  DownloadRecord,
  DownloadView,
  ParsedIntake,
  ParsedIntakeBatch,
  Ruleset,
} from "../domain/types";
import { parseIntake, parseIntakeBatch } from "../intake/parser";
import { readClipboardText } from "../intake/clipboard";
import { planDownload } from "../downloads/planner";
import { canStartDownload, isDownloadAllowedNow, runDownloadTask } from "../downloads/engine";

export class DaemonService {
  private readonly events = new EventHub();
  private readonly speedByDownload = new Map<string, number>();
  private readonly signals = new Map<string, AbortController>();
  private readonly activePromises = new Map<string, Promise<void>>();
  private repository!: Repository;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private clipboardTimer: ReturnType<typeof setInterval> | null = null;
  private lastClipboardSnapshot = "";

  constructor(
    private readonly paths: AppPaths,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    ensureAppPaths(this.paths);
    const db = await initDatabase(this.paths.dbPath);
    this.repository = new Repository(db);
  }

  startBackgroundLoops(): void {
    this.schedulerTimer = setInterval(() => {
      void this.tickScheduler();
    }, 1000);
    void this.tickScheduler();

    this.clipboardTimer = setInterval(() => {
      void this.tickClipboardWatcher();
    }, 5000);
  }

  stopBackgroundLoops(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
    }
    if (this.clipboardTimer) {
      clearInterval(this.clipboardTimer);
    }
  }

  subscribe(listener: (event: DaemonEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  listDownloads(activeOnly = false): DownloadView[] {
    const rows = activeOnly ? this.repository.listActiveDownloads() : this.repository.listDownloads();
    return rows.map((download) => this.repository.toView(download, this.speedByDownload.get(download.id) ?? 0));
  }

  listHistory(): DownloadView[] {
    return this.repository
      .listHistory()
      .map((download) => this.repository.toView(download, this.speedByDownload.get(download.id) ?? 0));
  }

  getDownload(id: string): DownloadDetails | null {
    return this.repository.getDownloadDetails(id);
  }

  getSettings(): AppSettings {
    return this.repository.getSettings();
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    return this.repository.setSettings(patch);
  }

  getStatus(): { ok: true; active: number; history: number; queue: number; clipboardWatcherEnabled: boolean } {
    const active = this.listDownloads(true).length;
    const history = this.listHistory().length;
    const queue = this.repository
      .listDownloads()
      .filter((download) => ["queued", "waiting_for_schedule", "paused", "restart_required"].includes(download.status))
      .length;
    return {
      ok: true,
      active,
      history,
      queue,
      clipboardWatcherEnabled: this.getSettings().clipboardWatcherEnabled,
    };
  }

  listRulesets(): Ruleset[] {
    return this.repository.listRulesets();
  }

  getRuleset(id: string): Ruleset | null {
    return this.repository.getRuleset(id);
  }

  createRuleset(input: CreateRulesetInput): Ruleset {
    return this.repository.createRuleset(input);
  }

  updateRuleset(id: string, patch: Partial<CreateRulesetInput & Pick<Ruleset, "enabled" | "priority">>): Ruleset {
    return this.repository.updateRuleset(id, patch);
  }

  deleteRuleset(id: string): void {
    this.repository.deleteRuleset(id);
  }

  listAuthProfiles(): AuthProfile[] {
    return this.repository.listAuthProfiles();
  }

  getAuthProfile(id: string): AuthProfile | null {
    return this.repository.getAuthProfile(id);
  }

  createAuthProfile(input: CreateAuthProfileInput): AuthProfile {
    return this.repository.createAuthProfile(input);
  }

  updateAuthProfile(id: string, patch: Partial<CreateAuthProfileInput>): AuthProfile {
    return this.repository.updateAuthProfile(id, patch);
  }

  deleteAuthProfile(id: string): void {
    this.repository.deleteAuthProfile(id);
  }

  parseIntake(source: string, intakeKind: AddDownloadInput["intakeKind"] = "auto"): ParsedIntake {
    return parseIntake(source, intakeKind ?? "auto");
  }

  parseIntakeBatch(source: string, intakeKind: AddDownloadInput["intakeKind"] = "auto"): ParsedIntakeBatch {
    return parseIntakeBatch(source, intakeKind ?? "auto");
  }

  addDownload(input: AddDownloadInput): { download: DownloadRecord; warnings: string[] } {
    const parsed = this.parseIntake(input.source, input.intakeKind);
    const planned = planDownload(
      input,
      parsed,
      this.getSettings(),
      this.repository.listRulesets(),
      this.repository.listAuthProfiles(),
      this.paths.downloadsDir,
    );
    this.repository.createDownload(planned.download);
    this.publish("download.added", { url: planned.download.url, warnings: planned.warnings }, planned.download.id);
    void this.tickScheduler();
    return planned;
  }

  bulkAdd(inputs: AddDownloadInput[]): { downloads: DownloadRecord[]; warnings: string[] } {
    const downloads: DownloadRecord[] = [];
    const warnings: string[] = [];
    for (const input of inputs) {
      const result = this.addDownload(input);
      downloads.push(result.download);
      warnings.push(...result.warnings);
    }
    return { downloads, warnings };
  }

  pauseDownload(id: string | "all"): void {
    const ids = id === "all" ? this.repository.listActiveDownloads().map((download) => download.id) : [id];
    for (const downloadId of ids) {
      const controller = this.signals.get(downloadId);
      if (controller) {
        controller.abort(new Error("Download paused"));
      }
      const current = this.repository.getDownload(downloadId);
      if (current) {
        this.repository.updateDownload(downloadId, { status: "paused" });
        this.publish("download.paused", {}, downloadId);
      }
    }
  }

  resumeDownload(id: string | "all"): void {
    const targets =
      id === "all"
        ? this.repository.listDownloads().filter((download) => download.status === "paused" || download.status === "restart_required")
        : [this.repository.getDownload(id)].filter(Boolean);

    for (const target of targets) {
      if (!target) {
        continue;
      }
      if (!target.resumable && target.downloadedBytes > 0) {
        void rm(target.tempPath, { force: true });
        this.repository.updateDownload(target.id, { downloadedBytes: 0, status: "queued" });
      } else {
        this.repository.updateDownload(target.id, { status: "queued" });
      }
      this.publish("download.resumed", {}, target.id);
    }
    void this.tickScheduler();
  }

  cancelDownload(id: string | "all"): void {
    const ids = id === "all" ? this.repository.listActiveDownloads().map((download) => download.id) : [id];
    for (const downloadId of ids) {
      const controller = this.signals.get(downloadId);
      if (controller) {
        controller.abort(new Error("Download canceled"));
      }
      const current = this.repository.getDownload(downloadId);
      if (!current) {
        continue;
      }
      this.repository.updateDownload(downloadId, { status: "canceled", errorCode: "canceled", errorMessage: null });
      this.publish("download.canceled", {}, downloadId);
    }
  }

  retryDownload(id: string | "failed" | "all"): void {
    const downloads =
      id === "all"
        ? this.repository.listDownloads()
        : id === "failed"
          ? this.repository.listDownloads().filter((download) => download.status === "failed")
          : [this.repository.getDownload(id)].filter(Boolean);

    for (const download of downloads) {
      if (!download) {
        continue;
      }
      this.repository.updateDownload(download.id, {
        status: "queued",
        errorCode: null,
        errorMessage: null,
      });
      this.publish("download.retry_requested", {}, download.id);
    }
    void this.tickScheduler();
  }

  async removeDownload(id: string, deleteFiles = false): Promise<void> {
    const download = this.repository.getDownload(id);
    if (!download) {
      return;
    }
    this.cancelDownload(id);
    if (deleteFiles) {
      if (existsSync(download.tempPath)) {
        await rm(download.tempPath, { force: true });
      }
      if (existsSync(download.finalPath)) {
        await rm(download.finalPath, { force: true });
      }
    }
    this.repository.deleteDownload(id);
    this.publish("download.removed", { deleteFiles }, id);
  }

  listEvents(): DaemonEvent[] {
    return this.repository.listEvents();
  }

  getRepository(): Repository {
    return this.repository;
  }

  private async tickScheduler(): Promise<void> {
    const settings = this.getSettings();
    const active = this.repository
      .listActiveDownloads()
      .filter((download) => this.activePromises.has(download.id) && download.status === "downloading");
    const scheduledByHost = new Map<string, number>();
    let scheduledCount = active.length;
    for (const download of active) {
      scheduledByHost.set(download.host, (scheduledByHost.get(download.host) ?? 0) + 1);
    }

    const candidates = this.repository
      .listDownloads()
      .sort((left, right) => {
        const leftHostCount = scheduledByHost.get(left.host) ?? 0;
        const rightHostCount = scheduledByHost.get(right.host) ?? 0;
        if (leftHostCount !== rightHostCount) {
          return leftHostCount - rightHostCount;
        }
        return left.createdAt.localeCompare(right.createdAt);
      });
    for (const record of candidates) {
      const ruleset = record.rulesetId ? this.repository.getRuleset(record.rulesetId) : null;
      const scheduleOpen = isDownloadAllowedNow(ruleset, settings);
      if (
        !scheduleOpen &&
        record.status === "queued" &&
        (ruleset?.actions.some((action) => action.type === "set_schedule_window") || settings.quietHours)
      ) {
        this.repository.updateDownload(record.id, {
          status: "waiting_for_schedule",
          errorCode: "waiting_for_schedule",
          errorMessage: "Queued until the next allowed schedule window.",
        });
        this.publish("download.waiting_for_schedule", {}, record.id);
      }
      if (!scheduleOpen) {
        continue;
      }
      if (!canStartDownload(record, active, settings, ruleset)) {
        continue;
      }
      if (this.activePromises.has(record.id)) {
        continue;
      }
      if (scheduledCount >= settings.globalConcurrency) {
        break;
      }
      const hostCount = scheduledByHost.get(record.host) ?? 0;
      if (hostCount >= settings.perHostConcurrency) {
        continue;
      }
      const task = runDownloadTask(
        {
          repo: this.repository,
          publish: (event) => this.events.publish(event),
          createEvent: (type, payload, downloadId) => this.createEvent(type, payload, downloadId ?? null),
          logger: this.logger,
          getSettings: () => this.getSettings(),
          getRuleset: (id) => (id ? this.repository.getRuleset(id) : null),
          signalForDownload: (downloadId) => this.signalForDownload(downloadId),
          clearSignal: (downloadId) => this.signals.delete(downloadId),
          setSpeed: (downloadId, speed) => this.speedByDownload.set(downloadId, speed),
          getHostCapability: (host) => this.repository.getHostCapability(host),
          setHostCapability: (capability) => this.repository.setHostCapability(capability),
        },
        record,
      ).finally(() => {
        this.activePromises.delete(record.id);
      });
      this.activePromises.set(record.id, task);
      scheduledByHost.set(record.host, hostCount + 1);
      scheduledCount += 1;
    }
  }

  private async tickClipboardWatcher(): Promise<void> {
    if (!this.getSettings().clipboardWatcherEnabled) {
      return;
    }

    try {
      const clipboard = await readClipboardText();
      if (!clipboard || clipboard === this.lastClipboardSnapshot) {
        return;
      }
      this.lastClipboardSnapshot = clipboard;
      try {
        const parsed = parseIntake(clipboard);
        this.publish("clipboard.candidate", { kind: parsed.kind, url: parsed.url }, null);
      } catch {
        // Ignore non-download clipboard contents.
      }
    } catch {
      // Clipboard support is best-effort.
    }
  }

  private signalForDownload(downloadId: string): AbortSignal {
    let controller = this.signals.get(downloadId);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      this.signals.set(downloadId, controller);
    }
    return controller.signal;
  }

  private createEvent(type: string, payload: Record<string, unknown>, downloadId: string | null): DaemonEvent {
    return this.events.create(type, payload, downloadId);
  }

  private publish(type: string, payload: Record<string, unknown>, downloadId: string | null): void {
    const event = this.createEvent(type, payload, downloadId);
    this.repository.addEvent(event);
    this.events.publish(event);
  }
}
