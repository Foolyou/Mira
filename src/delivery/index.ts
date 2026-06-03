// delivery/index.ts — the channel port. A channel just takes a rendered
// payload and gets it in front of the user. Config lives only in the Mira
// workspace, never in the agent, so Claude Code and Codex deliver byte-for-byte
// identically.
import type { Database } from "bun:sqlite";
import { StdoutChannel } from "./stdout.ts";
import { EmailChannel } from "./email.ts";

export interface Payload {
  subject: string;
  text: string;
  html?: string;
  imagePath?: string;
}

export interface Channel {
  send(payload: Payload): Promise<void>;
}

// Resolve a channel by name. Unknown names fall back to stdout so a
// misconfiguration degrades to "printed" rather than "silently dropped".
export function getChannel(db: Database, name: string): Channel {
  switch (name) {
    case "email":
      return new EmailChannel(db);
    case "stdout":
    case "":
      return new StdoutChannel();
    default:
      // ntfy/feishu are future fast channels; until implemented, be loud.
      return new StdoutChannel(`(channel '${name}' not implemented; using stdout)`);
  }
}
