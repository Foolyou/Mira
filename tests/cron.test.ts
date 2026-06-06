// cron install / uninstall. cronLines emits the schedule; cronUninstall is its
// inverse — it strips Mira's managed lines from an existing crontab by content
// (so a hand-moved block is still removed) and leaves everything else intact.
import { test, expect, describe } from "bun:test";
import { cronLines, cronUninstall } from "../src/install.ts";

const target = { invoker: { command: "/home/me/.mira/bin/mira", prefix: [] }, cwd: "/home/me/proj" };
const other = { invoker: { command: "/home/me/.mira/bin/mira", prefix: [] }, cwd: "/home/me/other" };

describe("cronLines", () => {
  test("runs Mira from the installed cwd instead of passing a workspace", () => {
    const lines = cronLines(target);
    expect(lines).toContain("# Mira — cwd=/home/me/proj");
    expect(lines).toContain("cd '/home/me/proj' && /home/me/.mira/bin/mira sweep");
    expect(lines).not.toContain("MIRA_WORKSPACE=");
    expect(lines).not.toContain("--workspace");
  });
});

describe("cronUninstall", () => {
  test("removes exactly this directory's block, keeping foreign and other Mira entries", () => {
    const foreignTop = "# my backup job\n0 3 * * * /usr/bin/backup";
    const foreignBottom = "*/10 * * * * /usr/bin/ping-check";
    const crontab = `${foreignTop}\n${cronLines(target)}${cronLines(other)}${foreignBottom}\n`;

    const cleaned = cronUninstall(crontab, target.cwd);
    expect(cleaned).toContain("/usr/bin/backup");
    expect(cleaned).toContain("/usr/bin/ping-check");
    expect(cleaned).not.toContain("cd '/home/me/proj'");
    expect(cleaned).toContain("cd '/home/me/other'");
    expect(cleaned).toContain("# Mira — cwd=/home/me/other");
  });

  test("strips a legacy workspace block for this directory only", () => {
    const crontab = [
      "MIRA_WORKSPACE=/home/me/proj/.mira",
      "0 9 * * * /opt/mira brief --send >> /tmp/b.log 2>&1",
      "MIRA_WORKSPACE=/somewhere/.mira",
      "0 9 * * * /opt/mira brief --send >> /tmp/other.log 2>&1",
      "# unrelated",
      "5 5 * * * /usr/bin/thing",
    ].join("\n");
    const cleaned = cronUninstall(crontab, target.cwd);
    expect(cleaned).not.toContain("/tmp/b.log");
    expect(cleaned).toContain("MIRA_WORKSPACE=/somewhere/.mira");
    expect(cleaned).toContain("/tmp/other.log");
    expect(cleaned).toContain("/usr/bin/thing");
    expect(cleaned).toContain("# unrelated");
  });

  test("an empty crontab stays empty", () => {
    expect(cronUninstall("", target.cwd)).toBe("");
  });
});
