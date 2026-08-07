#!/usr/bin/env bun
import { getAppPaths } from "../lib/paths";
import { runCli } from "../cli/run";

try {
  await runCli(Bun.argv.slice(2), getAppPaths());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

