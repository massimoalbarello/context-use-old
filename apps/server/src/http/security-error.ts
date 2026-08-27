export class SecurityError extends Error {
  // biome-ignore lint/complexity/useMaxParams: Error constructors conventionally take message and status.
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = "SecurityError";
  }
}
