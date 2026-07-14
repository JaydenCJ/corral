import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("version", () => {
  it("matches package.json to prevent drift", () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("starts at or above 0.1.0", () => {
    const [major, minor] = VERSION.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(0);
    if (major === 0) expect(minor).toBeGreaterThanOrEqual(1);
  });
});
