import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../../src/api/server";
import { DaemonService } from "../../src/daemon/service";
import { Logger } from "../../src/lib/logger";
import type { AppPaths } from "../../src/lib/paths";

const FIXTURE_TEXT = "download-manager integration fixture";

describe("daemon download service", () => {
  let tempRoot = "";
  const activeServices: DaemonService[] = [];

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "dlm-test-"));
  });

  afterEach(() => {
    for (const service of activeServices.splice(0)) {
      service.stopBackgroundLoops();
    }
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("downloads a file end-to-end", async () => {
    const payload = new TextEncoder().encode(FIXTURE_TEXT);
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const range = request.headers.get("range");
        if (request.method === "HEAD") {
          return new Response(null, {
            headers: {
              "content-length": String(payload.length),
              "accept-ranges": "bytes",
              "content-type": "text/plain",
            },
          });
        }

        if (range) {
          const match = range.match(/bytes=(\d+)-(\d+)?/);
          const start = Number(match?.[1] ?? 0);
          const end = Number(match?.[2] ?? payload.length - 1);
          return new Response(payload.slice(start, end + 1), {
            status: 206,
            headers: {
              "content-length": String(end - start + 1),
              "content-range": `bytes ${start}-${end}/${payload.length}`,
              "accept-ranges": "bytes",
              "content-type": "text/plain",
            },
          });
        }

        return new Response(payload, {
          headers: {
            "content-length": String(payload.length),
            "accept-ranges": "bytes",
            "content-type": "text/plain",
          },
        });
      },
    });

    const { service, outputDir } = await createService(tempRoot, activeServices);

    try {
      const result = service.addDownload({
        source: `http://127.0.0.1:${server.port}/fixture.txt`,
        destinationDir: outputDir,
      });

      const completed = await waitForCompletion(service, result.download.id);
      expect(completed?.download.status).toBe("completed");
      const filePath = join(outputDir, "fixture.txt");
      expect(await fs.readFile(filePath, "utf8")).toBe(FIXTURE_TEXT);
    } finally {
      service.stopBackgroundLoops();
      server.stop(true);
    }
  });

  test("stays waiting when quiet hours block scheduling", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("blocked");
      },
    });

    const { service } = await createService(tempRoot, activeServices);
    await service.updateSettings({ quietHours: "always" });

    try {
      const result = service.addDownload({
        source: `http://127.0.0.1:${server.port}/quiet.txt`,
      });

      const details = await waitForStatus(service, result.download.id, "waiting_for_schedule");
      expect(details?.download.status).toBe("waiting_for_schedule");
    } finally {
      service.stopBackgroundLoops();
      server.stop(true);
    }
  });

  test("marks a resumed partial download as restart_required on validator mismatch", async () => {
    let etag = "\"v2\"";
    const payload = new TextEncoder().encode("abcdefghijklmno");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "HEAD") {
          return new Response(null, {
            headers: {
              "content-length": String(payload.length),
              "accept-ranges": "bytes",
              etag,
            },
          });
        }
        const range = request.headers.get("range");
        if (range) {
          const match = range.match(/bytes=(\d+)-(\d+)?/);
          const start = Number(match?.[1] ?? 0);
          const end = Number(match?.[2] ?? payload.length - 1);
          return new Response(payload.slice(start, end + 1), {
            status: 206,
            headers: {
              "content-length": String(end - start + 1),
              "content-range": `bytes ${start}-${end}/${payload.length}`,
              "accept-ranges": "bytes",
              etag,
            },
          });
        }
        return new Response(payload, {
          headers: {
            "content-length": String(payload.length),
            "accept-ranges": "bytes",
            etag,
          },
        });
      },
    });

    const { service, outputDir } = await createService(tempRoot, activeServices);

    try {
      const result = service.addDownload({
        source: `http://127.0.0.1:${server.port}/validator.txt`,
        destinationDir: outputDir,
        startPaused: true,
      });
      const repo = service.getRepository();
      repo.updateDownload(result.download.id, {
        downloadedBytes: 5,
        resumable: true,
        etag: "\"v1\"",
        status: "paused",
      });
      await fs.writeFile(result.download.tempPath, payload.slice(0, 5));
      service.resumeDownload(result.download.id);

      const details = await waitForStatus(service, result.download.id, "restart_required");
      expect(details?.download.errorCode).toBe("validator_mismatch");
    } finally {
      service.stopBackgroundLoops();
      server.stop(true);
    }
  });

  test("overwrites an existing file when conflict strategy is overwrite", async () => {
    const payload = new TextEncoder().encode("replacement");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "HEAD") {
          return new Response(null, {
            headers: {
              "content-length": String(payload.length),
              "content-type": "text/plain",
            },
          });
        }
        return new Response(payload, {
          headers: {
            "content-length": String(payload.length),
            "content-type": "text/plain",
          },
        });
      },
    });

    const { service, outputDir } = await createService(tempRoot, activeServices);

    try {
      const target = join(outputDir, "replace.txt");
      await fs.writeFile(target, "old");
      const result = service.addDownload({
        source: `http://127.0.0.1:${server.port}/replace.txt`,
        destinationDir: outputDir,
        filename: "replace.txt",
        conflictStrategy: "overwrite",
      });

      const details = await waitForStatus(service, result.download.id, "completed");
      expect(details?.download.status).toBe("completed");
      expect(await fs.readFile(target, "utf8")).toBe("replacement");
    } finally {
      service.stopBackgroundLoops();
      server.stop(true);
    }
  });

  test("adding a download stays healthy after an event-stream client disconnects", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "HEAD") {
          return new Response(null, {
            headers: {
              "content-length": String(FIXTURE_TEXT.length),
              "content-type": "text/plain",
            },
          });
        }
        return new Response(FIXTURE_TEXT, {
          headers: {
            "content-length": String(FIXTURE_TEXT.length),
            "content-type": "text/plain",
          },
        });
      },
    });

    const { service, paths, outputDir } = await createService(tempRoot, activeServices);
    const apiServer = startApiServer(service, paths.socketPath);

    try {
      const response = await fetch("http://localhost/events", {
        unix: paths.socketPath,
        headers: { accept: "text/event-stream" },
      });
      expect(response.ok).toBe(true);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      await reader!.read();
      await reader!.cancel();
      await Bun.sleep(25);

      expect(() =>
        service.addDownload({
          source: `http://127.0.0.1:${server.port}/stream-fixture.txt`,
          destinationDir: outputDir,
        }),
      ).not.toThrow();

      const downloads = service.listDownloads();
      expect(downloads.some((download) => download.url.includes("/stream-fixture.txt"))).toBe(true);
    } finally {
      apiServer.stop(true);
      service.stopBackgroundLoops();
      server.stop(true);
    }
  });
});

async function waitForCompletion(service: DaemonService, id: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const download = service.getDownload(id);
    if (download?.download.status === "completed") {
      return download;
    }
    if (download?.download.status === "failed") {
      throw new Error(download.download.errorMessage ?? "Download failed");
    }
    await Bun.sleep(100);
  }
  throw new Error("Timed out waiting for download completion");
}

async function waitForStatus(service: DaemonService, id: string, status: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const download = service.getDownload(id);
    if (download?.download.status === status) {
      return download;
    }
    if (download?.download.status === "failed" && status !== "failed") {
      throw new Error(download.download.errorMessage ?? "Download failed");
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for download status ${status}`);
}

async function createService(
  root: string,
  activeServices: DaemonService[] = [],
): Promise<{ service: DaemonService; paths: AppPaths; outputDir: string }> {
  const paths: AppPaths = {
    appRoot: root,
    dbPath: join(root, "state.db"),
    downloadsDir: join(root, "partials"),
    logsDir: join(root, "logs"),
    logPath: join(root, "logs", "daemon.log"),
    socketDir: join(root, "run"),
    socketPath: join(root, "run", "dlm.sock"),
    pidPath: join(root, "run", "dlmd.pid"),
  };
  const outputDir = join(root, "out");
  await fs.mkdir(outputDir, { recursive: true });
  const service = new DaemonService(paths, new Logger(paths.logPath));
  await service.init();
  service.startBackgroundLoops();
  activeServices.push(service);
  return { service, paths, outputDir };
}
