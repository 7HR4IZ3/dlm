import { constants, promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
}

export async function ensureFilePermissions(path: string): Promise<void> {
  await fs.chmod(path, 0o600).catch(() => {});
}

export function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim().replace(/[\/\\?%*:|"<>]/g, "_");
  return trimmed.length > 0 ? trimmed : "download";
}

export async function resolveConflictPath(
  directory: string,
  desiredFilename: string,
  mode: "auto-rename" | "overwrite" | "skip" = "auto-rename",
): Promise<string | null> {
  const target = join(directory, desiredFilename);
  if (mode === "overwrite") {
    return target;
  }

  const exists = await fileExists(target);
  if (!exists) {
    return target;
  }

  if (mode === "skip") {
    return null;
  }

  const extension = extname(desiredFilename);
  const base = basename(desiredFilename, extension);
  let index = 1;
  while (true) {
    const candidate = join(directory, `${base} (${index})${extension}`);
    if (!(await fileExists(candidate))) {
      return candidate;
    }
    index += 1;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

