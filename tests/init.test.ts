// `mira init` / initWorkspace — a workspace is a `.mira` directory that must be
// created explicitly; data commands error until it exists. init is idempotent
// and adopts a legacy nested `.mira/workspace/mira.db` by copying it up.
import { test, expect, describe, afterAll } from "bun:test";
import { initWorkspace, isInitialized, openDb, configSet, configGet } from "../src/db.ts";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, existsSync, mkdirSync, rmSync } from "fs";

const made: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mira-init-"));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of made) try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("initWorkspace", () => {
  test("creates a fresh workspace and reports created=true", () => {
    withCwd(tempDir(), () => {
      const ws = join(process.cwd(), ".mira");
      expect(isInitialized()).toBe(false);
      const res = initWorkspace();
      expect(res.created).toBe(true);
      expect(res.db_path).toBe(join(ws, "mira.db"));
      expect(res.migrated_from).toBeUndefined();
      expect(isInitialized()).toBe(true);
    });
  });

  test("is idempotent — re-init reports created=false and preserves data", () => {
    withCwd(tempDir(), () => {
      const ws = join(process.cwd(), ".mira");
      initWorkspace();
      // write a row, then re-init, and confirm it survives
      let db = openDb({ path: join(ws, "mira.db") });
      configSet(db, "marker", "kept");
      db.close();
      const res = initWorkspace();
      expect(res.created).toBe(false);
      db = openDb({ path: join(ws, "mira.db") });
      const v = configGet(db, "marker");
      db.close();
      expect(v).toBe("kept");
    });
  });

  test("adopts a legacy .mira/workspace/mira.db by copying it up (backup left)", () => {
    withCwd(tempDir(), () => {
      const ws = join(process.cwd(), ".mira");
      // simulate the pre-redesign nested layout with a row in it
      const legacyDir = join(ws, "workspace");
      mkdirSync(legacyDir, { recursive: true });
      const legacy = join(legacyDir, "mira.db");
      let db = openDb({ path: legacy });
      configSet(db, "marker", "legacy-data");
      db.close();

      const res = initWorkspace();
      expect(res.created).toBe(true);
      expect(res.migrated_from).toBe(legacy);
      // data made it to the new top-level db
      db = openDb({ path: join(ws, "mira.db") });
      const v = configGet(db, "marker");
      db.close();
      expect(v).toBe("legacy-data");
      // legacy file left in place as a backup
      expect(existsSync(legacy)).toBe(true);
    });
  });
});

function withCwd<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  try {
    process.chdir(dir);
    return fn();
  } finally {
    process.chdir(prev);
  }
}
