import { test, expect, describe, afterAll } from "bun:test";
import { openDb } from "../src/db.ts";
import { sendMail } from "../src/delivery/index.ts";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

let counter = 0;
const made: string[] = [];
function freshDbPath(): string {
  const p = join(tmpdir(), `mira-mail-${process.pid}-${counter++}.db`);
  made.push(p);
  return p;
}

afterAll(() => {
  for (const p of made) for (const s of ["", "-wal", "-shm"]) try { rmSync(p + s); } catch {}
});

describe("mail send", () => {
  test("sends rich text through a selected channel and derives text fallback", async () => {
    const db = openDb({ path: freshDbPath() });
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: any) => {
      writes.push(String(s));
      return true;
    }) as any;
    try {
      const res = await sendMail(db, {
        channel: "stdout",
        subject: "Status",
        html: "<h1>Status</h1><p>All &amp; well</p>",
      });
      expect(res.sent).toBe(true);
      expect(res.channel).toBe("stdout");
      expect(res.payload.text).toBe("Status\nAll & well");
      expect(res.payload.html).toContain("<h1>Status</h1>");
      const emitted = JSON.parse(writes[0]);
      expect(emitted.subject).toBe("Status");
      expect(emitted.html).toContain("All &amp; well");
    } finally {
      process.stdout.write = origWrite;
      db.close();
    }
  });

  test("requires a subject and at least one body format", async () => {
    const db = openDb({ path: freshDbPath() });
    await expect(sendMail(db, { channel: "stdout", subject: "", text: "x" })).rejects.toThrow();
    await expect(sendMail(db, { channel: "stdout", subject: "x" })).rejects.toThrow();
    db.close();
  });
});
