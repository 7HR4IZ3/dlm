import type { AddDownloadInput, CreateAuthProfileInput, CreateRulesetInput, ParsedIntakeBatch } from "../domain/types";
import type { AppPaths } from "../lib/paths";
import { parseArgs, getBooleanFlag, getMultiFlag, getStringFlag } from "./args";
import { printAuthProfiles, printDownloadDetails, printDownloads, printEvents, printRulesets } from "./format";
import { ensureDaemon } from "../daemon/spawn";
import { readClipboardText } from "../intake/clipboard";
import { createDownloadInputsFromBatch } from "../intake/parser";
import { launchTui } from "../tui/app";

export async function runCli(argv: string[], paths: AppPaths): Promise<void> {
  const [command = "list", subcommand, ...rest] = argv;
  if (command === "tui") {
    const client = await ensureDaemon(paths);
    await launchTui(client);
    return;
  }

  const client = await ensureDaemon(paths);
  const parsed = parseArgs(rest);

  switch (command) {
    case "add": {
      const source = [subcommand, ...parsed.positionals].filter(Boolean).join(" ");
      if (!source) {
        throw new Error("Source URL or snippet is required.");
      }
      const headers = parseHeaders(getMultiFlag(parsed.flags, "header"));
      const input: AddDownloadInput = {
        source,
        intakeKind: (getStringFlag(parsed.flags, "type") as AddDownloadInput["intakeKind"]) ?? "auto",
        destinationDir: getStringFlag(parsed.flags, "dir"),
        filename: getStringFlag(parsed.flags, "filename"),
        headers,
        authProfileId: getStringFlag(parsed.flags, "auth-profile"),
        rulesetId: getStringFlag(parsed.flags, "ruleset") ?? null,
        tags: getMultiFlag(parsed.flags, "tag"),
        maxSegments: parseOptionalNumber(getStringFlag(parsed.flags, "segments")),
        rateLimitBytesPerSec: parseOptionalNumber(getStringFlag(parsed.flags, "rate-limit")),
        startPaused: getBooleanFlag(parsed.flags, "paused") || getBooleanFlag(parsed.flags, "start-paused"),
        conflictStrategy: getBooleanFlag(parsed.flags, "overwrite")
          ? "overwrite"
          : getBooleanFlag(parsed.flags, "skip-existing")
            ? "skip"
            : "auto-rename",
        postprocess: {
          verify: getBooleanFlag(parsed.flags, "verify"),
          organize: getBooleanFlag(parsed.flags, "organize"),
          extract: getBooleanFlag(parsed.flags, "extract"),
          notify: getBooleanFlag(parsed.flags, "notify"),
          openFile: getBooleanFlag(parsed.flags, "open-file"),
          openFolder: getBooleanFlag(parsed.flags, "open-folder"),
        },
      };
      const checksum = getStringFlag(parsed.flags, "checksum");
      if (checksum) {
        const [algorithm, value] = checksum.split(":", 2);
        if (algorithm && value) {
          input.checksum = { algorithm: algorithm as "sha256" | "sha512" | "md5", value };
        }
      }
      const batch = await client.parseIntakeBatch(source, input.intakeKind ?? "auto");
      if (batch.kind === "har") {
        const queued = await queueBatch(client, batch, input);
        console.log(JSON.stringify({ parsed: batch, queued }, null, 2));
        return;
      }
      const created = await client.addDownload(input);
      console.log(JSON.stringify(created, null, 2));
      return;
    }
    case "import": {
      const fromClipboard = getBooleanFlag(parsed.flags, "from-clipboard");
      const explicit = [subcommand, ...parsed.positionals].filter(Boolean).join(" ");
      const source = fromClipboard ? await readClipboardText() : explicit;
      if (!source) {
        throw new Error("No input provided.");
      }
      const intakeBatch = await client.parseIntakeBatch(
        source,
        (getStringFlag(parsed.flags, "type") as "auto" | "url" | "curl" | "fetch" | "har") ?? "auto",
      );
      if (getBooleanFlag(parsed.flags, "queue")) {
        const queued = await queueBatch(client, intakeBatch, {
          source,
          intakeKind: intakeBatch.kind,
          destinationDir: getStringFlag(parsed.flags, "dir"),
          filename: getStringFlag(parsed.flags, "filename"),
          authProfileId: getStringFlag(parsed.flags, "auth-profile"),
        });
        console.log(JSON.stringify({ parsed: intakeBatch, queued }, null, 2));
        return;
      }
      console.log(JSON.stringify(intakeBatch.kind === "har" ? intakeBatch : intakeBatch.items[0], null, 2));
      return;
    }
    case "list": {
      const history = getBooleanFlag(parsed.flags, "history");
      const downloads = history ? await client.listHistory() : await client.listDownloads(getBooleanFlag(parsed.flags, "active"));
      if (getBooleanFlag(parsed.flags, "json")) {
        console.log(JSON.stringify(downloads, null, 2));
      } else {
        printDownloads(downloads);
      }
      return;
    }
    case "show": {
      if (!subcommand) {
        throw new Error("Download id is required.");
      }
      const details = await client.getDownload(subcommand);
      printDownloadDetails(details);
      return;
    }
    case "pause":
      await client.pauseDownload(subcommand === "all" ? "all" : requireValue(subcommand, "download id"));
      return;
    case "resume":
      await client.resumeDownload(subcommand === "all" ? "all" : requireValue(subcommand, "download id"));
      return;
    case "cancel":
      await client.cancelDownload(subcommand === "all" ? "all" : requireValue(subcommand, "download id"));
      return;
    case "retry":
      await client.retryDownload(
        subcommand === "all" || subcommand === "failed" ? subcommand : requireValue(subcommand, "download id"),
      );
      return;
    case "remove":
      await client.removeDownload(requireValue(subcommand, "download id"), getBooleanFlag(parsed.flags, "delete-files"));
      return;
    case "watch":
      for await (const event of client.events()) {
        printEvents(event);
      }
      return;
    case "status":
      console.log(JSON.stringify(await client.daemonStatus(), null, 2));
      return;
    case "ruleset":
      await handleRulesets(client, subcommand, parsed);
      return;
    case "auth-profile":
      await handleAuthProfiles(client, subcommand, parsed);
      return;
    case "config":
      await handleConfig(client, subcommand, parsed);
      return;
    default:
      printHelp();
  }
}

async function handleRulesets(client: Awaited<ReturnType<typeof ensureDaemon>>, action: string | undefined, parsed: ReturnType<typeof parseArgs>) {
  switch (action) {
    case "list":
      printRulesets(await client.listRulesets());
      return;
    case "show": {
      const rulesets = await client.listRulesets();
      const ruleset = rulesets.find((item) => item.id === parsed.positionals[0]);
      console.log(JSON.stringify(ruleset ?? null, null, 2));
      return;
    }
    case "add": {
      const payload = parseJsonFlag<CreateRulesetInput>(parsed);
      console.log(JSON.stringify(await client.createRuleset(payload), null, 2));
      return;
    }
    case "edit": {
      const id = parsed.positionals[0];
      if (!id) {
        throw new Error("Ruleset id is required.");
      }
      const payload = parseJsonFlag<Partial<CreateRulesetInput>>(parsed);
      console.log(JSON.stringify(await client.updateRuleset(id, payload), null, 2));
      return;
    }
    case "remove":
      await client.deleteRuleset(requireValue(parsed.positionals[0], "ruleset id"));
      return;
    default:
      printRulesets(await client.listRulesets());
  }
}

async function handleAuthProfiles(client: Awaited<ReturnType<typeof ensureDaemon>>, action: string | undefined, parsed: ReturnType<typeof parseArgs>) {
  switch (action) {
    case "list":
      printAuthProfiles(await client.listAuthProfiles());
      return;
    case "show": {
      const profiles = await client.listAuthProfiles();
      const profile = profiles.find((item) => item.id === parsed.positionals[0]);
      console.log(JSON.stringify(profile ?? null, null, 2));
      return;
    }
    case "add": {
      const name = getStringFlag(parsed.flags, "name") ?? parsed.positionals[0];
      if (!name) {
        throw new Error("Auth profile name is required.");
      }
      const input: CreateAuthProfileInput = {
        name,
        headers: parseHeaders(getMultiFlag(parsed.flags, "header")),
      };
      console.log(JSON.stringify(await client.createAuthProfile(input), null, 2));
      return;
    }
    case "remove":
      await client.deleteAuthProfile(requireValue(parsed.positionals[0], "auth profile id"));
      return;
    case "edit": {
      const id = parsed.positionals[0];
      if (!id) {
        throw new Error("Auth profile id is required.");
      }
      const patch: Partial<CreateAuthProfileInput> = {};
      const name = getStringFlag(parsed.flags, "name");
      if (name) {
        patch.name = name;
      }
      const headers = parseHeaders(getMultiFlag(parsed.flags, "header"));
      if (Object.keys(headers).length > 0) {
        patch.headers = headers;
      }
      console.log(JSON.stringify(await client.updateAuthProfile(id, patch), null, 2));
      return;
    }
    default:
      printAuthProfiles(await client.listAuthProfiles());
  }
}

async function handleConfig(client: Awaited<ReturnType<typeof ensureDaemon>>, action: string | undefined, parsed: ReturnType<typeof parseArgs>) {
  if (action === "get") {
    console.log(JSON.stringify(await client.getSettings(), null, 2));
    return;
  }
  if (action === "set") {
    const payload = parseJsonFlag<Record<string, unknown>>(parsed);
    console.log(JSON.stringify(await client.updateSettings(payload), null, 2));
    return;
  }
  console.log(JSON.stringify(await client.getSettings(), null, 2));
}

function parseHeaders(values: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const value of values) {
    const [key, ...rest] = value.split(":");
    if (!key || rest.length === 0) {
      continue;
    }
    headers[key.trim()] = rest.join(":").trim();
  }
  return headers;
}

function parseJsonFlag<T>(parsed: ReturnType<typeof parseArgs>): T {
  const raw = getStringFlag(parsed.flags, "json") ?? parsed.positionals.join(" ");
  if (!raw) {
    throw new Error("JSON payload is required.");
  }
  return JSON.parse(raw) as T;
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}

function parseOptionalNumber(value: string | undefined): number | null | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric value, received "${value}".`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`dlm commands:
  dlm tui
  dlm add <url-or-snippet-or.har> [--type auto|url|curl|fetch|har] [--dir ...] [--filename ...] [--header K:V] [--overwrite]
  dlm import [--from-clipboard] [--type auto|url|curl|fetch|har] [--queue] [input]
  dlm list [--active] [--history] [--json]
  dlm show <id>
  dlm status
  dlm pause <id|all>
  dlm resume <id|all>
  dlm cancel <id|all>
  dlm retry <id|failed|all>
  dlm remove <id> [--delete-files]
  dlm watch
  dlm ruleset add|list|show|edit|remove
  dlm auth-profile add|list|show|edit|remove
  dlm config get|set`);
}

async function queueBatch(
  client: Awaited<ReturnType<typeof ensureDaemon>>,
  batch: ParsedIntakeBatch,
  input: AddDownloadInput,
) {
  if (batch.kind === "har") {
    const resolved = createDownloadInputsFromBatch(batch, {
      destinationDir: input.destinationDir,
      filename: input.filename,
      headers: input.headers,
      authProfileId: input.authProfileId,
      rulesetId: input.rulesetId,
      tags: input.tags,
      checksum: input.checksum,
      postprocess: input.postprocess,
      maxSegments: input.maxSegments,
      rateLimitBytesPerSec: input.rateLimitBytesPerSec,
      startPaused: input.startPaused,
      conflictStrategy: input.conflictStrategy,
    });
    return await client.bulkAdd(resolved);
  }

  return await client.addDownload(input);
}
