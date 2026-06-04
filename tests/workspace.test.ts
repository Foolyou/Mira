import { test, expect, describe, afterAll } from "bun:test";
import { resolveWorkspace, setWorkspaceOverride, isInitialized } from "../src/db.ts";
import { defaultSkillWorkspace, installSkill } from "../src/install.ts";
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
  test("defaults to the current working directory's .mira (no /workspace subdir)", () => {
    const cwd = process.cwd();
    const prevEnv = process.env.MIRA_WORKSPACE;
    const dir = tempDir();
    setWorkspaceOverride(null);
    delete process.env.MIRA_WORKSPACE;
    try {
      process.chdir(dir);
      expect(resolveWorkspace()).toBe(join(dir, ".mira"));
    } finally {
      process.chdir(cwd);
      if (prevEnv === undefined) delete process.env.MIRA_WORKSPACE;
      else process.env.MIRA_WORKSPACE = prevEnv;
      setWorkspaceOverride(null);
    }
  });

  test("keeps explicit override and env precedence above cwd default", () => {
    const prevEnv = process.env.MIRA_WORKSPACE;
    setWorkspaceOverride(null);
    process.env.MIRA_WORKSPACE = "/tmp/mira-env-workspace";
    try {
      expect(resolveWorkspace()).toBe("/tmp/mira-env-workspace");
      setWorkspaceOverride("/tmp/mira-override-workspace");
      expect(resolveWorkspace()).toBe("/tmp/mira-override-workspace");
    } finally {
      if (prevEnv === undefined) delete process.env.MIRA_WORKSPACE;
      else process.env.MIRA_WORKSPACE = prevEnv;
      setWorkspaceOverride(null);
    }
  });
});

describe("skill workspace binding", () => {
  test("project skill binds to (and initializes) cwd .mira", () => {
    const cwd = tempDir();
    const res = installSkill("codex", "project", { cwd }) as any;
    const body = readFileSync(res.wrote, "utf8");
    expect(res.workspace).toBe(join(cwd, ".mira"));
    expect(body).toContain(`--workspace ${join(cwd, ".mira")}`);
    // requirement: installing into a directory without .mira auto-inits it
    expect(res.initialized).toBe(true);
    expect(isInitialized(join(cwd, ".mira"))).toBe(true);
  });

  test("user skill bakes NO workspace and tells the agent to mira init its cwd", () => {
    const cwd = tempDir();
    const codexHome = tempDir();
    const prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      expect(defaultSkillWorkspace("user", cwd)).toBeUndefined();
      const res = installSkill("codex", "user", { cwd }) as any;
      const body = readFileSync(res.wrote, "utf8");
      expect(res.wrote).toBe(join(codexHome, "skills", "mira", "SKILL.md"));
      expect(res.workspace).toBeNull();
      expect(res.initialized).toBe(false);
      // no concrete workspace path baked in (only relative guidance + mira init)
      expect(body).not.toContain(join(cwd, ".mira"));
      expect(body).not.toContain(`--workspace ${join(cwd, ".mira")}`);
      expect(body).toContain("mira init");
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
    }
  });

  test("explicit skill workspace is normalized, written into SKILL.md, and initialized", () => {
    const cwd = tempDir();
    const res = installSkill("claude-code", "project", {
      cwd,
      workspace: "custom-mira",
    }) as any;
    const body = readFileSync(res.wrote, "utf8");
    expect(res.workspace).toBe(join(cwd, "custom-mira"));
    expect(body).toContain(`--workspace ${join(cwd, "custom-mira")}`);
    expect(isInitialized(join(cwd, "custom-mira"))).toBe(true);
  });
});
