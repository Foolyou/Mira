// delivery/stdout.ts — structured JSON to stdout. Used for development,
// dry-runs, and the `agent` delivery mode where the brain enriches/forwards.
import type { Channel, Payload } from "./index.ts";

export class StdoutChannel implements Channel {
  constructor(private note?: string) {}
  async send(payload: Payload): Promise<void> {
    const out = {
      channel: "stdout",
      ...(this.note ? { note: this.note } : {}),
      subject: payload.subject,
      text: payload.text,
      ...(payload.html ? { html: payload.html } : {}),
      ...(payload.imagePath ? { imagePath: payload.imagePath } : {}),
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  }
}
