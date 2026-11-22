const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Format a byte count like backend.config.human_size (e.g. 1.5 GB). */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  for (const unit of UNITS) {
    if (value < 1024 || unit === 'PB') {
      return unit === 'B' ? `${Math.round(value)} B` : `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${value.toFixed(1)} PB`;
}
