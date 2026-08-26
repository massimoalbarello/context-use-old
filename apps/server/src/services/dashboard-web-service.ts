import { resolve } from "node:path";

export class DashboardWebService {
  private readonly webRoot: string;

  constructor(webDist: string) {
    this.webRoot = resolve(webDist);
  }

  async file(path: string): Promise<Bun.BunFile | null> {
    const resolved = resolve(this.webRoot, path);
    if (!resolved.startsWith(`${this.webRoot}/`)) {
      return null;
    }
    const file = Bun.file(resolved);
    return (await file.exists()) ? file : null;
  }
}
