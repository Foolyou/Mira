// cron install / uninstall. cronLines emits the schedule; cronUninstall is its
// inverse — it strips Mira's managed lines from an existing crontab by content
// (so a hand-moved block is still removed) and leaves everything else intact.
import { test, expect, describe } from "bun:test";
import { cronLines, cronUninstall } from "../src/install.ts";

const target = { invoker: { command: "/home/me/.mira/bin/mira", prefix: [] }, workspace: "/home/me/proj/.mira" };

describe("cronUninstall", () => {
  test("removes exactly the block cronLines produced, keeping foreign entries", () => {
    const foreignTop = "# my backup job\n0 3 * * * /usr/bin/backup";
    const foreignBottom = "*/10 * * * * /usr/bin/ping-check";
    const crontab = `${foreignTop}\n${cronLines(target)}${foreignBottom}\n`;

    const cleaned = cronUninstall(crontab);
    expect(cleaned).toContain("/usr/bin/backup");
    expect(cleaned).toContain("/usr/bin/ping-check");
    // every Mira line is gone
    expect(cleaned).not.toContain("mira sweep");
    expect(cleaned).not.toContain("mira brief");
    expect(cleaned).not.toContain("MIRA_WORKSPACE=");
    expect(cleaned).not.toMatch(/#\s*Mira/);
  });

  test("strips a hand-moved block matched by content, not position", () => {
    const crontab = [
      "MIRA_WORKSPACE=/somewhere/.mira",
      "0 9 * * * /opt/mira brief --send >> /tmp/b.log 2>&1",
      "# unrelated",
      "5 5 * * * /usr/bin/thing",
    ].join("\n");
    const cleaned = cronUninstall(crontab);
    expect(cleaned).not.toContain("mira brief");
    expect(cleaned).not.toContain("MIRA_WORKSPACE=");
    expect(cleaned).toContain("/usr/bin/thing");
    expect(cleaned).toContain("# unrelated");
  });

  test("an empty crontab stays empty", () => {
    expect(cronUninstall("")).toBe("");
  });
});
