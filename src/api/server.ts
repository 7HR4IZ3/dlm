import type { DaemonService } from "../daemon/service";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function startApiServer(service: DaemonService, socketPath: string) {
  return Bun.serve({
    unix: socketPath,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === "/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && path === "/downloads") {
        const activeOnly = url.searchParams.get("active") === "true";
        return json(service.listDownloads(activeOnly));
      }

      if (request.method === "POST" && path === "/downloads") {
        const body = await request.json();
        return json(service.addDownload(body), 201);
      }

      if (request.method === "POST" && path === "/downloads/bulk") {
        const body = (await request.json()) as { downloads: unknown[] };
        return json(service.bulkAdd(body.downloads as never[]), 201);
      }

      if (request.method === "GET" && path === "/history") {
        return json(service.listHistory());
      }

      if (request.method === "GET" && path === "/events") {
        return eventStream(service);
      }

      if (request.method === "GET" && path === "/rulesets") {
        return json(service.listRulesets());
      }

      if (request.method === "POST" && path === "/rulesets") {
        return json(service.createRuleset(await request.json()), 201);
      }

      if (request.method === "GET" && path === "/auth-profiles") {
        return json(service.listAuthProfiles());
      }

      if (request.method === "POST" && path === "/auth-profiles") {
        return json(service.createAuthProfile(await request.json()), 201);
      }

      if (request.method === "GET" && path === "/settings") {
        return json(service.getSettings());
      }

      if (request.method === "PATCH" && path === "/settings") {
        return json(service.updateSettings(await request.json()));
      }

      if (request.method === "POST" && path === "/intake/parse") {
        const body = (await request.json()) as { source: string; intakeKind?: "auto" | "url" | "curl" | "fetch" | "har" };
        return json(service.parseIntake(body.source, body.intakeKind));
      }

      if (request.method === "POST" && path === "/intake/parse-batch") {
        const body = (await request.json()) as { source: string; intakeKind?: "auto" | "url" | "curl" | "fetch" | "har" };
        return json(service.parseIntakeBatch(body.source, body.intakeKind));
      }

      if (request.method === "POST" && path === "/daemon/shutdown") {
        queueMicrotask(() => {
          service.stopBackgroundLoops();
          process.exit(0);
        });
        return json({ ok: true });
      }

      if (request.method === "GET" && path === "/daemon/status") {
        return json(service.getStatus());
      }

      const downloadMatch = path.match(/^\/downloads\/([^/]+)$/);
      if (request.method === "GET" && downloadMatch) {
        const details = service.getDownload(downloadMatch[1]!);
        return details ? json(details) : json({ error: "Not found" }, 404);
      }

      const actionMatch = path.match(/^\/downloads\/([^/]+)\/(pause|resume|cancel|retry)$/);
      if (request.method === "POST" && actionMatch) {
        const [, id, action] = actionMatch;
        switch (action) {
          case "pause":
            service.pauseDownload(id!);
            break;
          case "resume":
            service.resumeDownload(id!);
            break;
          case "cancel":
            service.cancelDownload(id!);
            break;
          case "retry":
            service.retryDownload(id!);
            break;
        }
        return json({ ok: true });
      }

      if (request.method === "DELETE" && downloadMatch) {
        const deleteFiles = url.searchParams.get("deleteFiles") === "true";
        await service.removeDownload(downloadMatch[1]!, deleteFiles);
        return json({ ok: true });
      }

      const rulesetMatch = path.match(/^\/rulesets\/([^/]+)$/);
      if (rulesetMatch) {
        if (request.method === "GET") {
          const ruleset = service.getRuleset(rulesetMatch[1]!);
          return ruleset ? json(ruleset) : json({ error: "Not found" }, 404);
        }
        if (request.method === "PATCH") {
          return json(service.updateRuleset(rulesetMatch[1]!, await request.json()));
        }
        if (request.method === "DELETE") {
          service.deleteRuleset(rulesetMatch[1]!);
          return json({ ok: true });
        }
      }

      const authMatch = path.match(/^\/auth-profiles\/([^/]+)$/);
      if (authMatch) {
        if (request.method === "GET") {
          const authProfile = service.getAuthProfile(authMatch[1]!);
          return authProfile ? json(authProfile) : json({ error: "Not found" }, 404);
        }
        if (request.method === "PATCH") {
          return json(service.updateAuthProfile(authMatch[1]!, await request.json()));
        }
        if (request.method === "DELETE") {
          service.deleteAuthProfile(authMatch[1]!);
          return json({ ok: true });
        }
      }

      return json({ error: "Not found" }, 404);
    },
  });
}

function eventStream(service: DaemonService): Response {
  const encoder = new TextEncoder();
  const history = service.listEvents();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (closed) {
          return;
        }
        closed = true;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      };

      const safeEnqueue = (payload: string) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          cleanup();
        }
      };

      for (const event of history) {
        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
      }

      unsubscribe = service.subscribe((event) => {
        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
      });

      heartbeat = setInterval(() => {
        safeEnqueue(": heartbeat\n\n");
      }, 15000);

      safeEnqueue(": connected\n\n");
    },
    cancel() {
      // Bun closes the underlying controller before calling cancel, so the
      // stream teardown must be driven by the guarded enqueue path above.
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
