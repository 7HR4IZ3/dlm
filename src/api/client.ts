import type {
  AddDownloadInput,
  AppSettings,
  AuthProfile,
  CreateAuthProfileInput,
  CreateRulesetInput,
  DaemonEvent,
  DownloadDetails,
  DownloadView,
  ParsedIntake,
  ParsedIntakeBatch,
  Ruleset,
} from "../domain/types";

export class ApiClient {
  constructor(private readonly socketPath: string) {}

  async health(): Promise<boolean> {
    const response = await this.request("/health");
    return response.ok;
  }

  async listDownloads(activeOnly = false): Promise<DownloadView[]> {
    return await this.json(`/downloads?active=${activeOnly}`);
  }

  async listHistory(): Promise<DownloadView[]> {
    return await this.json("/history");
  }

  async addDownload(input: AddDownloadInput): Promise<{ download: unknown; warnings: string[] }> {
    return await this.json("/downloads", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async bulkAdd(inputs: AddDownloadInput[]): Promise<{ downloads: unknown[]; warnings: string[] }> {
    return await this.json("/downloads/bulk", {
      method: "POST",
      body: JSON.stringify({ downloads: inputs }),
    });
  }

  async getDownload(id: string): Promise<DownloadDetails> {
    return await this.json(`/downloads/${id}`);
  }

  async pauseDownload(id: string | "all"): Promise<void> {
    if (id === "all") {
      const downloads = await this.listDownloads(true);
      await Promise.all(downloads.map((download) => this.pauseDownload(download.id)));
      return;
    }
    await this.json(`/downloads/${id}/pause`, { method: "POST" });
  }

  async resumeDownload(id: string | "all"): Promise<void> {
    if (id === "all") {
      const downloads = await this.listDownloads();
      await Promise.all(
        downloads.filter((download) => download.status === "paused").map((download) => this.resumeDownload(download.id)),
      );
      return;
    }
    await this.json(`/downloads/${id}/resume`, { method: "POST" });
  }

  async cancelDownload(id: string | "all"): Promise<void> {
    if (id === "all") {
      const downloads = await this.listDownloads(true);
      await Promise.all(downloads.map((download) => this.cancelDownload(download.id)));
      return;
    }
    await this.json(`/downloads/${id}/cancel`, { method: "POST" });
  }

  async retryDownload(id: string | "failed" | "all"): Promise<void> {
    if (id === "all") {
      const downloads = await this.listDownloads();
      await Promise.all(downloads.map((download) => this.retryDownload(download.id)));
      return;
    }
    if (id === "failed") {
      const downloads = await this.listDownloads();
      await Promise.all(
        downloads.filter((download) => download.status === "failed").map((download) => this.retryDownload(download.id)),
      );
      return;
    }
    await this.json(`/downloads/${id}/retry`, { method: "POST" });
  }

  async removeDownload(id: string, deleteFiles = false): Promise<void> {
    await this.json(`/downloads/${id}?deleteFiles=${deleteFiles}`, { method: "DELETE" });
  }

  async listRulesets(): Promise<Ruleset[]> {
    return await this.json("/rulesets");
  }

  async getRuleset(id: string): Promise<Ruleset> {
    return await this.json(`/rulesets/${id}`);
  }

  async createRuleset(input: CreateRulesetInput): Promise<Ruleset> {
    return await this.json("/rulesets", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateRuleset(id: string, patch: Partial<CreateRulesetInput & Pick<Ruleset, "enabled" | "priority">>): Promise<Ruleset> {
    return await this.json(`/rulesets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async deleteRuleset(id: string): Promise<void> {
    await this.json(`/rulesets/${id}`, { method: "DELETE" });
  }

  async listAuthProfiles(): Promise<AuthProfile[]> {
    return await this.json("/auth-profiles");
  }

  async getAuthProfile(id: string): Promise<AuthProfile> {
    return await this.json(`/auth-profiles/${id}`);
  }

  async createAuthProfile(input: CreateAuthProfileInput): Promise<AuthProfile> {
    return await this.json("/auth-profiles", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateAuthProfile(id: string, patch: Partial<CreateAuthProfileInput>): Promise<AuthProfile> {
    return await this.json(`/auth-profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async deleteAuthProfile(id: string): Promise<void> {
    await this.json(`/auth-profiles/${id}`, { method: "DELETE" });
  }

  async getSettings(): Promise<AppSettings> {
    return await this.json("/settings");
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return await this.json("/settings", { method: "PATCH", body: JSON.stringify(patch) });
  }

  async parseIntake(source: string, intakeKind: "auto" | "url" | "curl" | "fetch" | "har" = "auto"): Promise<ParsedIntake> {
    return await this.json("/intake/parse", {
      method: "POST",
      body: JSON.stringify({ source, intakeKind }),
    });
  }

  async parseIntakeBatch(
    source: string,
    intakeKind: "auto" | "url" | "curl" | "fetch" | "har" = "auto",
  ): Promise<ParsedIntakeBatch> {
    return await this.json("/intake/parse-batch", {
      method: "POST",
      body: JSON.stringify({ source, intakeKind }),
    });
  }

  async daemonStatus(): Promise<{ ok: boolean; active: number; history: number; queue: number; clipboardWatcherEnabled: boolean }> {
    return await this.json("/daemon/status");
  }

  async shutdown(): Promise<void> {
    await this.json("/daemon/shutdown", { method: "POST" });
  }

  async *events(): AsyncGenerator<DaemonEvent> {
    const response = await fetch("http://localhost/events", {
      unix: this.socketPath,
      headers: { accept: "text/event-stream" },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Unable to connect to event stream: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n\n")) {
        const index = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const lines = frame.split("\n").filter((line) => line.startsWith("data: "));
        for (const line of lines) {
          yield JSON.parse(line.slice(6)) as DaemonEvent;
        }
      }
    }
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) {
      throw new Error(await response.text());
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return await fetch(`http://localhost${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
      unix: this.socketPath,
    });
  }
}
