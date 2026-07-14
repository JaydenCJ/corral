import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmDir, tmpDir } from "./helpers.js";

/** Grab a port the OS just handed out, then release it so nothing is listening. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let home: string;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI from source under tsx with an isolated CORRAL_HOME. */
function runCli(args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, CORRAL_HOME: home, CORRAL_DEBUG: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

beforeEach(() => {
  home = tmpDir();
});
afterEach(() => {
  rmDir(home);
});

describe("corral CLI", () => {
  it("--version prints the version and exits 0", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("0.1.0");
  });

  it("--help and the version in help agree", async () => {
    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("corral 0.1.0");
    expect(help.stdout).toContain("the no-fork local model runner");
  });

  it("exits 2 on an unknown command", async () => {
    const r = await runCli(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command "frobnicate"');
  });

  it("exits 2 on an invalid backend flag", async () => {
    const r = await runCli(["serve", "--backend", "notreal"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown backend");
  });

  it("ls reports no models on a fresh home", async () => {
    const r = await runCli(["ls"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No models installed");
  });

  it("show exits 1 for a model that is not installed", async () => {
    const r = await runCli(["show", "nope/nope:Q4"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("is not installed");
  });

  it("run --prompt drives an inline mock server end-to-end", async () => {
    const r = await runCli(["run", "demo-model", "--backend", "mock", "--prompt", "ping"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[demo-model] echo: ping");
  });

  it("run --prompt exits non-zero when the request fails", async () => {
    // Point at a closed port so the one-shot request cannot succeed; a failed
    // run must surface as a non-zero exit code (regression: it used to exit 0).
    const dead = await closedPort();
    const r = await runCli([
      "run",
      "demo-model",
      "--serve-url",
      `http://127.0.0.1:${dead}`,
      "--prompt",
      "ping",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error:");
  });
});
