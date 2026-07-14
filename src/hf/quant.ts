import type { HfFileEntry } from "./client.js";

/** Result of choosing a single GGUF file from a repo listing. */
export interface QuantSelection {
  file: HfFileEntry;
  quant: string;
}

/**
 * Preference order used when the user does not pin a quant. Q4_K_M is the
 * community default sweet spot (good quality, ~4.5 bits), so it wins first.
 */
const DEFAULT_PREFERENCE = ["q4_k_m", "q4_k_s", "q5_k_m", "q5_k_s", "q8_0", "q6_k", "q4_0"];

const QUANT_PATTERN = /(iq\d[a-z0-9_]*|q\d(?:_[kmsxs0-9]+)*|bf16|f16|f32)/i;

/** Extract a quant tag (e.g. "Q4_K_M") from a GGUF filename, or null. */
export function extractQuant(filename: string): string | null {
  const base = filename.split("/").pop() ?? filename;
  const m = base.match(QUANT_PATTERN);
  return m ? m[0].toUpperCase() : null;
}

/** True for a multi-part split GGUF such as `model-00001-of-00003.gguf`. */
export function isSplitGguf(filename: string): boolean {
  return /-\d{5}-of-\d{5}\.gguf$/i.test(filename);
}

function listAvailableQuants(ggufs: HfFileEntry[]): string {
  const quants = ggufs.map((f) => extractQuant(f.path) ?? f.path.split("/").pop() ?? f.path);
  return [...new Set(quants)].join(", ");
}

/**
 * Choose the GGUF file to download. If `quant` is given, match the file whose
 * name contains that tag (case-insensitive). Otherwise fall back to the default
 * preference order, then to the single remaining file. Split GGUFs are rejected
 * with a clear message because multi-part assembly is out of scope for 0.1.0.
 */
export function selectGguf(files: HfFileEntry[], quant?: string): QuantSelection {
  const ggufs = files.filter((f) => f.path.toLowerCase().endsWith(".gguf"));
  if (ggufs.length === 0) {
    throw new Error("no .gguf files found in this repository");
  }

  let chosen: HfFileEntry | undefined;
  if (quant && quant.length > 0) {
    const needle = quant.toLowerCase();
    chosen = ggufs.find((f) => f.path.toLowerCase().includes(needle));
    if (!chosen) {
      throw new Error(
        `no GGUF file matching quant "${quant}". Available: ${listAvailableQuants(ggufs)}`,
      );
    }
  } else {
    for (const pref of DEFAULT_PREFERENCE) {
      chosen = ggufs.find((f) => f.path.toLowerCase().includes(pref));
      if (chosen) break;
    }
    if (!chosen) chosen = ggufs[0];
  }

  if (!chosen) {
    throw new Error("could not select a GGUF file");
  }
  if (isSplitGguf(chosen.path)) {
    throw new Error(
      `selected file "${chosen.path}" is a split (multi-part) GGUF, which is not supported yet. ` +
        `Pick a single-file quant instead. Available: ${listAvailableQuants(ggufs)}`,
    );
  }

  return { file: chosen, quant: extractQuant(chosen.path) ?? quant ?? "unknown" };
}
