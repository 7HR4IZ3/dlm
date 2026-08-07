import { describe, expect, test } from "bun:test";
import { isWithinSchedule, matchRule, resolveRules } from "../../src/rules/engine";
import type { AddDownloadInput, Ruleset } from "../../src/domain/types";

describe("rules engine", () => {
  test("matches host and glob rules", () => {
    expect(
      matchRule(
        { type: "host", value: "example.com" },
        { url: "https://example.com/file.zip", host: "example.com", tags: [] },
      ),
    ).toBe(true);

    expect(
      matchRule(
        { type: "url_glob", value: "https://example.com/*.zip" },
        { url: "https://example.com/file.zip", host: "example.com", tags: [] },
      ),
    ).toBe(true);
  });

  test("applies ruleset actions", () => {
    const input: AddDownloadInput = { source: "https://example.com/file.zip" };
    const ruleset: Ruleset = {
      id: "ruleset_1",
      name: "zip",
      enabled: true,
      priority: 10,
      matchers: [{ type: "extension", value: ".zip" }],
      actions: [
        { type: "set_destination_dir", value: "/tmp/downloads" },
        { type: "set_max_segments", value: 2 },
        { type: "toggle_postprocess", step: "extract", enabled: true },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const resolved = resolveRules(
      input,
      {
        url: "https://example.com/file.zip",
        host: "example.com",
        fileName: "file.zip",
        tags: [],
      },
      [ruleset],
      [],
    );

    expect(resolved.destinationDir).toBe("/tmp/downloads");
    expect(resolved.maxSegments).toBe(2);
    expect(resolved.postprocess.extract).toBe(true);
  });

  test("evaluates schedule windows", () => {
    const weekdayAtTen = new Date("2026-04-22T10:00:00.000Z");
    const weekdayAtTwentyThree = new Date("2026-04-22T23:00:00.000Z");
    expect(isWithinSchedule("daily@09:00-17:00", weekdayAtTen)).toBe(true);
    expect(isWithinSchedule("daily@09:00-17:00", weekdayAtTwentyThree)).toBe(false);
  });
});

