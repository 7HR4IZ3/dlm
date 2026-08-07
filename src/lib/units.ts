export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) {
    return "--";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;

  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }

  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

