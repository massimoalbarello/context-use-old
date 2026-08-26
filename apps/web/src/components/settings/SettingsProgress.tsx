export function SettingsProgress({ value, label }: { value: number | null; label: string }) {
  const percentage = value === null ? null : Math.max(0, Math.min(100, value * 100));
  return (
    <div className="archive-upload" role="status" aria-live="polite">
      <div className="archive-upload-copy">
        <strong>{label}</strong>
        <small>{percentage === null ? "Working…" : `${percentage.toFixed(1)}%`}</small>
      </div>
      <progress max={100} value={percentage ?? undefined} aria-label={label} />
    </div>
  );
}
