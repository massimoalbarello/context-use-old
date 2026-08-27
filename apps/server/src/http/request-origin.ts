export function requestMatchesOrigin({
  request,
  expectedOrigin,
}: {
  request: Request;
  expectedOrigin: string;
}): boolean {
  const actual = new URL(request.url);
  const expected = new URL(expectedOrigin);
  if (actual.host !== expected.host) {
    return false;
  }
  if (actual.protocol === expected.protocol) {
    return true;
  }
  return (
    actual.protocol === "http:" &&
    expected.protocol === "https:" &&
    request.headers.get("x-forwarded-proto") === "https"
  );
}
