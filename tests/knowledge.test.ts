import { test, expect, describe, afterAll } from "bun:test";
import { openDb } from "../src/db.ts";
import * as core from "../src/core.ts";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

let counter = 0;
const made: string[] = [];
function freshDbPath(): string {
  const p = join(tmpdir(), `mira-knowledge-${process.pid}-${counter++}.db`);
  made.push(p);
  return p;
}

afterAll(() => {
  for (const p of made) for (const s of ["", "-wal", "-shm"]) try { rmSync(p + s); } catch {}
});

describe("knowledge lists", () => {
  test("lists companies with type filtering", () => {
    const db = openDb({ path: freshDbPath() });
    core.addCompany(db, "Beta", "vendor");
    core.addCompany(db, "Acme", "client");

    const all = core.listCompanies(db) as any[];
    expect(all.map((c) => c.name)).toEqual(["Acme", "Beta"]);

    const clients = core.listCompanies(db, { type: "client" }) as any[];
    expect(clients.map((c) => c.name)).toEqual(["Acme"]);
    db.close();
  });

  test("lists projects, notes, and captures with useful filters", () => {
    const db = openDb({ path: freshDbPath() });
    const c = core.addCompany(db, "Acme") as any;
    const p = core.addProject(db, "Launch", c.id, "ship it") as any;
    core.addProject(db, "Unrelated", null);
    core.addNote(db, "call notes", { company_id: c.id, project_id: p.id, kind: "meeting" });
    core.addNote(db, "loose note", { kind: "quick_note" });
    core.capture(db, "inbox item", "inbox", "manual");
    core.capture(db, "email item", "inbox", "email");

    const projects = core.listProjects(db, { company_id: c.id }) as any[];
    expect(projects.map((r) => [r.name, r.company_name])).toEqual([["Launch", "Acme"]]);

    const notes = core.listNotes(db, { project_id: p.id, kind: "meeting" }) as any[];
    expect(notes.length).toBe(1);
    expect(notes[0].company_name).toBe("Acme");
    expect(notes[0].project_name).toBe("Launch");

    const captures = core.listCaptures(db, { source: "email" }) as any[];
    expect(captures.map((r) => r.raw_text)).toEqual(["email item"]);
    db.close();
  });
});
