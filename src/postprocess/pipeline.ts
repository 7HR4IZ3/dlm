import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { DownloadRecord, PostProcessPlan } from "../domain/types";
import { fileExists, resolveConflictPath } from "../lib/filesystem";

export interface PostProcessContext {
  download: DownloadRecord;
  postprocessPlan: PostProcessPlan;
  checksum:
    | {
        algorithm: "sha256" | "sha512" | "md5";
        value: string;
      }
    | null;
  notifyOnComplete: boolean;
}

export interface PostProcessResult {
  completedSteps: string[];
  messages: string[];
  finalPath: string;
}

export async function runPostProcess(context: PostProcessContext): Promise<PostProcessResult> {
  const messages: string[] = [];
  const completedSteps: string[] = [];
  let finalPath = context.download.finalPath;

  if (context.postprocessPlan.verify && context.checksum) {
    const valid = await verifyChecksum(finalPath, context.checksum.algorithm, context.checksum.value);
    completedSteps.push("verify");
    messages.push(valid ? "Checksum passed." : "Checksum failed.");
    if (!valid) {
      throw new Error("Checksum verification failed.");
    }
  }

  if (context.postprocessPlan.organize) {
    const candidate = await resolveConflictPath(dirname(finalPath), basename(finalPath), "auto-rename");
    if (candidate && candidate !== finalPath) {
      await fs.rename(finalPath, candidate);
      finalPath = candidate;
    }
    completedSteps.push("organize");
  }

  if (context.postprocessPlan.extract) {
    await extractArchive(finalPath);
    completedSteps.push("extract");
  }

  if (context.postprocessPlan.notify || context.notifyOnComplete) {
    await sendNotification(`Download complete: ${basename(finalPath)}`);
    completedSteps.push("notify");
  }

  if (context.postprocessPlan.openFile) {
    await openPath(finalPath);
  }

  if (context.postprocessPlan.openFolder) {
    await openPath(dirname(finalPath));
  }

  return { completedSteps, messages, finalPath };
}

async function verifyChecksum(
  filePath: string,
  algorithm: "sha256" | "sha512" | "md5",
  expected: string,
): Promise<boolean> {
  const hash = createHash(algorithm);
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex").toLowerCase() === expected.toLowerCase();
}

async function extractArchive(filePath: string): Promise<void> {
  const extension = extname(filePath).toLowerCase();
  const stem = basename(filePath, extension);
  const outputDir = join(dirname(filePath), stem);
  await fs.mkdir(outputDir, { recursive: true });

  let cmd: string[] | null = null;
  if (extension === ".zip") {
    cmd = ["unzip", "-o", filePath, "-d", outputDir];
  } else if (extension === ".tar" || extension === ".tgz" || filePath.endsWith(".tar.gz")) {
    cmd = ["tar", "-xf", filePath, "-C", outputDir];
  }

  if (!cmd) {
    return;
  }

  const proc = Bun.spawn({
    cmd,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderr || "Archive extraction failed.");
  }
}

async function sendNotification(message: string): Promise<void> {
  const commands =
    process.platform === "darwin"
      ? [
          ["terminal-notifier", "-title", "dlm", "-message", message],
          ["osascript", "-e", `display notification "${message.replace(/"/g, '\\"')}" with title "dlm"`],
        ]
      : [["notify-send", "dlm", message]];

  for (const cmd of commands) {
    try {
      const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
      const code = await proc.exited;
      if (code === 0) {
        return;
      }
    } catch {
      continue;
    }
  }
}

async function openPath(path: string): Promise<void> {
  if (!(await fileExists(path))) {
    return;
  }
  const cmd = process.platform === "darwin" ? ["open", path] : ["xdg-open", path];
  const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

