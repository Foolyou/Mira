import { test, expect, describe, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, mkdtempSync, rmSync } from "fs";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const made: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mira-cli-workspace-"));
  made.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of made) try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
}

describe("CLI workspace policy", () => {
  test("data commands require the current directory to be initialized", () => {
    const cwd = tempDir();
    const before = run(cwd, ["counts"]);
    expect(before.exitCode).toBe(1);
    expect(before.stderr.toString()).toContain("not in a Mira environment");

    const init = run(cwd, ["init"]);
    expect(init.exitCode).toBe(0);

    const after = run(cwd, ["counts"]);
    expect(after.exitCode).toBe(0);
    expect(JSON.parse(after.stdout.toString()).tasks_open).toBe(0);
  });

  test("manual workspace overrides are rejected", () => {
    const cwd = tempDir();
    expect(run(cwd, ["--workspace", "/tmp/other", "counts"]).stderr.toString()).toContain("no longer supported");
    expect(run(cwd, ["counts"], { MIRA_WORKSPACE: "/tmp/other" }).stderr.toString()).toContain("no longer supported");
  });

  test("init can install multiple agent skills", () => {
    const cwd = tempDir();
    const init = run(cwd, ["init", "--agent", "codex", "--agent", "claude-code"]);
    expect(init.exitCode).toBe(0);
    const res = JSON.parse(init.stdout.toString());
    expect(res.created).toBe(true);
    expect(res.skills.map((s: any) => s.agent).sort()).toEqual(["claude-code", "codex"]);
    expect(existsSync(join(cwd, ".codex", "skills", "mira", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude", "skills", "mira", "SKILL.md"))).toBe(true);
  });
});
