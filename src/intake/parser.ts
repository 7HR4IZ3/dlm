import { existsSync, readFileSync } from "node:fs";
import type { AddDownloadInput, IntakeKind, ParsedIntake, ParsedIntakeBatch } from "../domain/types";

type HarDocument = {
  log?: {
    entries?: HarEntry[];
  };
};

type HarEntry = {
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
  };
  response?: {
    headers?: HarHeader[];
  };
};

type HarHeader = {
  name?: string;
  value?: string;
};

export function parseIntake(source: string, preferredKind: IntakeKind | "auto" = "auto"): ParsedIntake {
  const batch = parseIntakeBatch(source, preferredKind);
  const first = batch.items[0];

  if (!first) {
    throw new Error("No importable request found.");
  }

  const warnings = [...batch.warnings, ...first.warnings];
  if (batch.kind === "har" && batch.items.length > 1) {
    warnings.push(`HAR contains ${batch.items.length} importable requests; using the first entry only.`);
  }

  return {
    ...first,
    warnings,
  };
}

export function parseIntakeBatch(source: string, preferredKind: IntakeKind | "auto" = "auto"): ParsedIntakeBatch {
  const trimmed = source.trim();
  const kind = preferredKind === "auto" ? detectKind(trimmed) : preferredKind;

  switch (kind) {
    case "curl":
      return singleItemBatch(kind, parseCurlSnippet(trimmed));
    case "fetch":
      return singleItemBatch(kind, parseFetchSnippet(trimmed));
    case "har":
      return parseHarInput(trimmed);
    case "url":
    default:
      return singleItemBatch(kind, parseUrlInput(trimmed));
  }
}

export function createDownloadInputsFromBatch(
  batch: ParsedIntakeBatch,
  base: Omit<AddDownloadInput, "source" | "intakeKind">,
): AddDownloadInput[] {
  return batch.items.map((item) => ({
    ...base,
    source: item.url,
    intakeKind: "url",
    filename: base.filename ?? item.filenameHint ?? undefined,
    headers: {
      ...item.headers,
      ...(base.headers ?? {}),
    },
  }));
}

function singleItemBatch(kind: IntakeKind, item: ParsedIntake): ParsedIntakeBatch {
  return {
    kind,
    items: [item],
    warnings: [],
  };
}

function detectKind(source: string): IntakeKind {
  if (/^\s*curl\b/i.test(source)) {
    return "curl";
  }
  if (/fetch\s*\(/.test(source)) {
    return "fetch";
  }
  if (loadHarDocument(source, false) != null) {
    return "har";
  }
  return "url";
}

export function parseUrlInput(source: string): ParsedIntake {
  const url = new URL(source);
  const filenameHint = url.pathname.split("/").filter(Boolean).at(-1) ?? null;
  return {
    kind: "url",
    url: url.toString(),
    method: "GET",
    headers: {},
    filenameHint,
    warnings: [],
  };
}

export function parseCurlSnippet(source: string): ParsedIntake {
  const tokens = shellSplit(source);
  const warnings: string[] = [];
  let url = "";
  let method = "GET";
  let output: string | null = null;
  const headers: Record<string, string> = {};

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = tokens[index + 1];

    if ((token === "-H" || token === "--header") && next) {
      const [key, ...rest] = next.split(":");
      if (key && rest.length > 0) {
        headers[key.trim()] = rest.join(":").trim();
      }
      index += 1;
      continue;
    }

    if ((token === "-X" || token === "--request") && next) {
      method = next.toUpperCase();
      index += 1;
      continue;
    }

    if ((token === "-o" || token === "--output") && next) {
      output = next;
      index += 1;
      continue;
    }

    if (token === "-d" || token === "--data" || token === "--data-binary") {
      warnings.push("Request body ignored for download intake.");
      index += 1;
      continue;
    }

    if (!token.startsWith("-") && !url) {
      url = stripQuotes(token);
    }
  }

  if (!url) {
    throw new Error("Unable to find URL in curl command.");
  }

  return {
    kind: "curl",
    url: new URL(stripQuotes(url)).toString(),
    method,
    headers,
    filenameHint: output ? stripQuotes(output.split("/").at(-1) ?? output) : null,
    warnings,
  };
}

export function parseFetchSnippet(source: string): ParsedIntake {
  const warnings: string[] = [];
  const normalized = source.trim().replace(/;+$/, "");
  const urlMatch = normalized.match(/fetch\s*\(\s*(['"`])(.+?)\1\s*(?:,|$)/s);
  if (!urlMatch) {
    throw new Error("Unable to parse fetch() snippet.");
  }

  const url = new URL(urlMatch[2]!).toString();
  const optionsMatch = normalized.match(/fetch\s*\(\s*(['"`]).+?\1\s*,\s*(\{[\s\S]*\})\s*\)$/s);
  const headers: Record<string, string> = {};
  let method = "GET";

  if (optionsMatch) {
    const optionsSource = jsObjectToJson(optionsMatch[2]!);
    try {
      const parsed = JSON.parse(optionsSource) as { method?: string; headers?: Record<string, string>; body?: string };
      method = parsed.method?.toUpperCase() ?? "GET";
      Object.assign(headers, parsed.headers ?? {});
      if (parsed.body != null) {
        warnings.push("Request body ignored for download intake.");
      }
    } catch {
      warnings.push("Could not fully parse fetch options; using URL only.");
    }
  }

  const filenameHint = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? null;

  return {
    kind: "fetch",
    url,
    method,
    headers,
    filenameHint,
    warnings,
  };
}

export function parseHarInput(source: string): ParsedIntakeBatch {
  const document = loadHarDocument(source, true);
  if (!document) {
    throw new Error("Unable to parse HAR input.");
  }

  const entries = document.log?.entries;
  if (!Array.isArray(entries)) {
    throw new Error("HAR file is missing log.entries.");
  }

  const warnings: string[] = [];
  const items: ParsedIntake[] = [];
  const seen = new Set<string>();
  let skippedUnsupportedMethod = 0;
  let skippedInvalidEntry = 0;
  let skippedUnsupportedProtocol = 0;
  let skippedDuplicate = 0;

  for (const entry of entries) {
    const method = entry.request?.method?.toUpperCase() ?? "GET";
    if (method !== "GET") {
      skippedUnsupportedMethod += 1;
      continue;
    }

    const rawUrl = entry.request?.url;
    if (!rawUrl) {
      skippedInvalidEntry += 1;
      continue;
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      skippedInvalidEntry += 1;
      continue;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      skippedUnsupportedProtocol += 1;
      continue;
    }

    const headers = headersToRecord(entry.request?.headers);
    const dedupeKey = `${url.toString()}|${stableHeaderKey(headers)}`;
    if (seen.has(dedupeKey)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(dedupeKey);

    items.push({
      kind: "har",
      url: url.toString(),
      method,
      headers,
      filenameHint: extractHarFilename(entry, url),
      warnings: [],
    });
  }

  if (items.length === 0) {
    throw new Error("HAR did not contain any importable GET requests.");
  }

  if (skippedUnsupportedMethod > 0) {
    warnings.push(`Skipped ${skippedUnsupportedMethod} non-GET HAR request(s).`);
  }
  if (skippedUnsupportedProtocol > 0) {
    warnings.push(`Skipped ${skippedUnsupportedProtocol} non-HTTP HAR request(s).`);
  }
  if (skippedDuplicate > 0) {
    warnings.push(`Skipped ${skippedDuplicate} duplicate HAR request(s).`);
  }
  if (skippedInvalidEntry > 0) {
    warnings.push(`Skipped ${skippedInvalidEntry} malformed HAR entr${skippedInvalidEntry === 1 ? "y" : "ies"}.`);
  }

  return {
    kind: "har",
    items,
    warnings,
  };
}

function loadHarDocument(source: string, required: boolean): HarDocument | null {
  const inlineCandidate = source.trim();

  if (inlineCandidate.startsWith("{")) {
    try {
      const parsed = JSON.parse(inlineCandidate) as HarDocument;
      if (isHarDocument(parsed)) {
        return parsed;
      }
    } catch {
      if (required) {
        throw new Error("HAR input is not valid JSON.");
      }
    }
  }

  if (existsSync(inlineCandidate) && (required || /\.har$/i.test(inlineCandidate))) {
    try {
      const parsed = JSON.parse(readFileSync(inlineCandidate, "utf8")) as HarDocument;
      if (isHarDocument(parsed)) {
        return parsed;
      }
    } catch {
      throw new Error(`Unable to read HAR file: ${inlineCandidate}`);
    }

    if (required) {
      throw new Error("File does not contain a valid HAR document.");
    }
  }

  if (required) {
    throw new Error("Input is not a valid HAR document or .har file path.");
  }

  return null;
}

function isHarDocument(value: unknown): value is HarDocument {
  return Boolean(
    value &&
      typeof value === "object" &&
      "log" in value &&
      value.log &&
      typeof value.log === "object" &&
      "entries" in value.log &&
      Array.isArray(value.log.entries),
  );
}

function headersToRecord(headers: HarHeader[] | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const header of headers ?? []) {
    if (!header?.name) {
      continue;
    }
    record[header.name] = header.value ?? "";
  }
  return record;
}

function stableHeaderKey(headers: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function extractHarFilename(entry: HarEntry, url: URL): string | null {
  const contentDisposition = findHeader(entry.response?.headers, "content-disposition");
  const fromDisposition = contentDisposition ? parseContentDispositionFilename(contentDisposition) : null;
  if (fromDisposition) {
    return fromDisposition;
  }
  return url.pathname.split("/").filter(Boolean).at(-1) ?? null;
}

function findHeader(headers: HarHeader[] | undefined, name: string): string | null {
  const match = (headers ?? []).find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
}

function parseContentDispositionFilename(value: string): string | null {
  const encoded = value.match(/filename\*\s*=\s*([^;]+)/i)?.[1]?.trim();
  if (encoded) {
    const normalized = encoded.replace(/^UTF-8''/i, "").replace(/^"(.*)"$/, "$1");
    try {
      return decodeURIComponent(normalized);
    } catch {
      return normalized;
    }
  }

  const plain = value.match(/filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+)/i)?.[1]?.trim();
  if (!plain) {
    return null;
  }
  return plain.replace(/^"(.*)"$/, "$1");
}

function jsObjectToJson(source: string): string {
  return source
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3')
    .replace(/'/g, '"')
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]");
}

function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}
