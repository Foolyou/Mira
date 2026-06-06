// delivery/feishu.ts — Feishu/Lark notifications via the user's local lark-cli.
// Mira stores no Feishu app credentials: lark-cli owns auth and profile state.
// Each send resolves the current user with user auth, then has the local app bot
// DM that account. Sending as the user to self does not reliably notify.
import type { Database } from "bun:sqlite";
import type { Channel, Payload } from "./index.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => CommandResult | Promise<CommandResult>;

const CLI = "lark-cli";

export class FeishuChannel implements Channel {
  constructor(private _db: Database, private run: CommandRunner = runLarkCli) {}

  async send(payload: Payload): Promise<void> {
    const userId = await this.selfOpenId();
    const text = formatMessage(payload);
    if (!text) throw new Error("feishu send needs a non-empty subject or text body");
    await this.checked([
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--user-id",
      userId,
      "--text",
      text,
      "--format",
      "json",
    ], "Feishu message send");
  }

  async verify(): Promise<void> {
    await this.selfOpenId();
    await this.botReady();
  }

  private async selfOpenId(): Promise<string> {
    const out = await this.checked([
      "contact",
      "+get-user",
      "--as",
      "user",
      "--format",
      "json",
    ], "Feishu current-user lookup");
    let parsed: any;
    try {
      parsed = JSON.parse(out || "{}");
    } catch {
      throw new Error("Feishu current-user lookup returned invalid JSON");
    }
    const id = parsed?.data?.user?.open_id;
    if (!id) throw new Error("Feishu current-user lookup returned no data.user.open_id");
    return String(id);
  }

  private async botReady(): Promise<void> {
    const out = await this.checked(["auth", "status"], "Feishu bot identity check");
    let parsed: any;
    try {
      parsed = JSON.parse(out || "{}");
    } catch {
      throw new Error("Feishu bot identity check returned invalid JSON");
    }
    const bot = parsed?.identities?.bot;
    if (!bot?.available || bot?.status !== "ready") {
      throw new Error(`Feishu bot identity is not ready: ${bot?.message ?? bot?.status ?? "missing bot status"}`);
    }
  }

  private async checked(args: string[], what: string): Promise<string> {
    const res = await this.run(args);
    if (res.exitCode !== 0) {
      const detail = [res.stderr.trim(), res.stdout.trim()].filter(Boolean).join(" — ");
      throw new Error(`${what} failed: exit ${res.exitCode}${detail ? ` — ${detail.slice(0, 400)}` : ""}`);
    }
    return res.stdout;
  }
}

function runLarkCli(args: string[]): CommandResult {
  try {
    const res = Bun.spawnSync([CLI, ...args], { stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: res.exitCode,
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
    };
  } catch (e: any) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: e?.message ? String(e.message) : `failed to execute ${CLI}`,
    };
  }
}

function formatMessage(payload: Payload): string {
  const subject = payload.subject.trim();
  const text = payload.text.trim();
  if (subject && text && subject !== text) return `${subject}\n\n${text}`;
  return subject || text;
}
