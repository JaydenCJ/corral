import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Locate an executable on PATH, returning its absolute path or null. A small,
 * dependency-free equivalent of `which` so backends can probe for their
 * upstream binary without shelling out.
 */
export function which(binary: string): string | null {
  const envPath = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of envPath.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      const candidate = join(dir, binary + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}
