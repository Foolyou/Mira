import { test, expect, describe, afterAll } from "bun:test";
import { resolveWorkspace, setWorkspaceOverride } from "../src/db.ts";
import { defaultSkillWorkspace, installSkill } from "../src/install.ts";
import { homedir, tmpdir } from "os";
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
  test("defaults to the current working directory's .mira/workspace", () => {
    const cwd = process.cwd();
    const prevEnv = process.env.MIRA_WORKSPACE;
    const dir = tempDir();
    setWorkspaceOverride(null);
    delete process.env.MIRA_WORKSPACE;
    try {
      process.chdir(dir);
      expect(resolveWorkspace()).toBe(join(dir, ".mira", "workspace"));
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
  test("project skill defaults to cwd .mira/workspace", () => {
    const cwd = tempDir();
    const res = installSkill("codex", "project", { cwd }) as any;
    const body = readFileSync(res.wrote, "utf8");
    expect(res.workspace).toBe(join(cwd, ".mira", "workspace"));
    expect(body).toContain(`--workspace ${join(cwd, ".mira", "workspace")}`);
  });

  test("user skill defaults to ~/.mira/workspace", () => {
    const cwd = tempDir();
    const codexHome = tempDir();
    const prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      expect(defaultSkillWorkspace("user", cwd)).toBe(join(homedir(), ".mira", "workspace"));
      const res = installSkill("codex", "user", { cwd }) as any;
      const body = readFileSync(res.wrote, "utf8");
      expect(res.wrote).toBe(join(codexHome, "skills", "mira", "SKILL.md"));
      expect(res.workspace).toBe(join(homedir(), ".mira", "workspace"));
      expect(body).toContain(`--workspace ${join(homedir(), ".mira", "workspace")}`);
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
    }
  });

  test("explicit skill workspace is normalized and written into SKILL.md", () => {
    const cwd = tempDir();
    const res = installSkill("claude-code", "project", {
      cwd,
      workspace: "custom-mira/workspace",
    }) as any;
    const body = readFileSync(res.wrote, "utf8");
    expect(res.workspace).toBe(join(cwd, "custom-mira", "workspace"));
    expect(body).toContain(`--workspace ${join(cwd, "custom-mira", "workspace")}`);
  });
});
