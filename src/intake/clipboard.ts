export async function readClipboardText(): Promise<string> {
  if (process.platform === "darwin") {
    return await runCapture(["pbpaste"]);
  }

  for (const command of [
    ["wl-paste", "--no-newline"],
    ["xclip", "-selection", "clipboard", "-o"],
    ["xsel", "--clipboard", "--output"],
  ]) {
    try {
      return await runCapture(command);
    } catch {
      continue;
    }
  }

  throw new Error("No supported clipboard command found.");
}

async function runCapture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Clipboard command failed: ${cmd.join(" ")}`);
  }
  return output.trim();
}

