import { test, expect, describe, afterAll } from "bun:test";
import { resolveWorkspace, openDb } from "../src/db.ts";
import { installSkill } from "../src/install.ts";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, readFileSync, rmSync } from "fs";

const made: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mira-workspace-"));
  made.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of made) try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("workspace resolution", () => {
  test("uses only the current working directory's .mira", () => {
    const cwd = process.cwd();
    const prevEnv = process.env.MIRA_WORKSPACE;
    const dir = tempDir();
    process.env.MIRA_WORKSPACE = "/tmp/ignored-mira-workspace";
    try {
      process.chdir(dir);
      expect(resolveWorkspace()).toBe(join(dir, ".mira"));
    } finally {
      process.chdir(cwd);
      if (prevEnv === undefined) delete process.env.MIRA_WORKSPACE;
      else process.env.MIRA_WORKSPACE = prevEnv;
    }
  });
});

describe("database open path", () => {
  test("opening a current DB does not need a write lock", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mira-db-open-"));
    const dbFile = join(cwd, "mira.db");
    const setup = openDb({ path: dbFile });
    setup.close();

    const writer = openDb({ path: dbFile });
    writer.exec("BEGIN IMMEDIATE");
    try {
      const reader = openDb({ path: dbFile });
      try {
        const row = reader.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
        expect(row.n).toBe(0);
      } finally {
        reader.close();
      }
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("skill workspace binding", () => {
  test("project skill writes cwd-local guidance without a workspace override", () => {
    const cwd = tempDir();
    const res = installSkill("codex", "project", { cwd }) as any;
    const body = readFileSync(res.wrote, "utf8");
    expect(res.cwd).toBe(cwd);
    expect(body).not.toContain(join(cwd, ".mira"));
    expect(body).not.toMatch(/(^|\n)mira\b[^\n]*--workspace/);
  });

  test("user skill bakes NO workspace and tells the agent to mira init its cwd", () => {
    const cwd = tempDir();
    const codexHome = tempDir();
    const prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const res = installSkill("codex", "user", { cwd }) as any;
      const body = readFileSync(res.wrote, "utf8");
      expect(res.wrote).toBe(join(codexHome, "skills", "mira", "SKILL.md"));
      // no concrete workspace path baked in (only relative guidance + mira init)
      expect(body).not.toContain(join(cwd, ".mira"));
      expect(body).not.toMatch(/(^|\n)mira\b[^\n]*--workspace/);
      expect(body).toContain("mira init");
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
    }
  });

});
