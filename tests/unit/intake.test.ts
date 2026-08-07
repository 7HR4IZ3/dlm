import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  createDownloadInputsFromBatch,
  parseCurlSnippet,
  parseFetchSnippet,
  parseIntake,
  parseIntakeBatch,
  parseUrlInput,
} from "../../src/intake/parser";

describe("intake parser", () => {
  test("parses plain url input", () => {
    const parsed = parseUrlInput("https://example.com/files/archive.zip");
    expect(parsed.kind).toBe("url");
    expect(parsed.url).toBe("https://example.com/files/archive.zip");
    expect(parsed.filenameHint).toBe("archive.zip");
  });

  test("parses curl snippet with headers and output name", () => {
    const parsed = parseCurlSnippet(
      `curl -H "Authorization: Bearer token" -H "X-Test: 1" -o test.bin https://example.com/file.bin`,
    );
    expect(parsed.kind).toBe("curl");
    expect(parsed.url).toBe("https://example.com/file.bin");
    expect(parsed.headers.Authorization).toBe("Bearer token");
    expect(parsed.headers["X-Test"]).toBe("1");
    expect(parsed.filenameHint).toBe("test.bin");
  });

  test("parses fetch snippet", () => {
    const parsed = parseFetchSnippet(`fetch("https://example.com/video.mp4", {
      method: "GET",
      headers: {
        Authorization: "Bearer test",
        "X-Trace": "123"
      }
    })`);
    expect(parsed.kind).toBe("fetch");
    expect(parsed.url).toBe("https://example.com/video.mp4");
    expect(parsed.method).toBe("GET");
    expect(parsed.headers.Authorization).toBe("Bearer test");
    expect(parsed.headers["X-Trace"]).toBe("123");
  });

  test("parses HAR JSON into multiple importable requests", () => {
    const parsed = parseIntakeBatch(createSampleHar());

    expect(parsed.kind).toBe("har");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.url).toBe("https://example.com/downloads/file-one.zip");
    expect(parsed.items[0]?.headers.Authorization).toBe("Bearer token");
    expect(parsed.items[0]?.filenameHint).toBe("file-one.zip");
    expect(parsed.items[1]?.url).toBe("https://example.com/files/file-two.tar.gz");
    expect(parsed.warnings).toContain("Skipped 1 non-GET HAR request(s).");
  });

  test("parses HAR file path input", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlm-har-test-"));
    const file = join(dir, "capture.har");

    try {
      writeFileSync(file, createSampleHar(), "utf8");
      const parsed = parseIntakeBatch(file);
      expect(parsed.kind).toBe("har");
      expect(parsed.items).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("single-intake HAR parsing falls back to the first request with warning", () => {
    const parsed = parseIntake(createSampleHar());

    expect(parsed.kind).toBe("har");
    expect(parsed.url).toBe("https://example.com/downloads/file-one.zip");
    expect(parsed.warnings).toContain("HAR contains 2 importable requests; using the first entry only.");
  });

  test("maps HAR batch items into queueable download inputs", () => {
    const batch = parseIntakeBatch(createSampleHar());
    const inputs = createDownloadInputsFromBatch(batch, {
      destinationDir: "/tmp/downloads",
      headers: { "X-Extra": "1" },
      conflictStrategy: "overwrite",
    });

    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      source: "https://example.com/downloads/file-one.zip",
      intakeKind: "url",
      destinationDir: "/tmp/downloads",
      filename: "file-one.zip",
      conflictStrategy: "overwrite",
    });
    expect(inputs[0]?.headers).toMatchObject({
      Authorization: "Bearer token",
      "X-Extra": "1",
    });
  });
});

function createSampleHar(): string {
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "test", version: "1.0" },
      entries: [
        {
          request: {
            method: "GET",
            url: "https://example.com/downloads/file-one.zip",
            headers: [{ name: "Authorization", value: "Bearer token" }],
          },
          response: {
            headers: [{ name: "Content-Disposition", value: 'attachment; filename="file-one.zip"' }],
          },
        },
        {
          request: {
            method: "POST",
            url: "https://example.com/api/session",
            headers: [],
          },
          response: {
            headers: [],
          },
        },
        {
          request: {
            method: "GET",
            url: "https://example.com/files/file-two.tar.gz",
            headers: [],
          },
          response: {
            headers: [],
          },
        },
      ],
    },
  });
}
