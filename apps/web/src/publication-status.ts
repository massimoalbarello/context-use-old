export function isPublishedPageOutdated(
  page: { current_version_id: string; published_version_id: string | null },
): boolean {
  return Boolean(
    page.published_version_id
    && page.published_version_id !== page.current_version_id,
  );
}
