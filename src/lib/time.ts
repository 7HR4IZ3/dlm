export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) {
    return "--";
  }

  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}h ${minutes}m ${secs}s`
    : minutes > 0
      ? `${minutes}m ${secs}s`
      : `${secs}s`;
}

