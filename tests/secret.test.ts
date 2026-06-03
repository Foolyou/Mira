// Secret handling — credentials must never reach stdout (redaction) and must be
// resolvable from an external file/env so the SQLite blob holds only a pointer.
import { test, expect, describe } from "bun:test";
import { redactConfigValue, redactConfigMap, resolveSecret } from "../src/secret.ts";
import { writeFileSync, rmSync } from "node:fs";

describe("redactConfigValue", () => {
  test("masks a literal app_password, keeps non-secret fields", () => {
    const v = JSON.stringify({ smtp_host: "smtp.mail.me.com", user: "a@b.com", app_password: "FAKE-test-secret-0000", to: "a@b.com" });
    const r = JSON.parse(redactConfigValue("channel.email", v)!);
    expect(r.app_password).toBe("***");
    expect(r.user).toBe("a@b.com");
    expect(r.smtp_host).toBe("smtp.mail.me.com");
  });

  test("leaves file:/env: references visible — they are pointers, not secrets", () => {
    const v = JSON.stringify({ user: "a@b.com", app_password: "file:~/.secrets/mira-smtp" });
    expect(JSON.parse(redactConfigValue("channel.email", v)!).app_password).toBe("file:~/.secrets/mira-smtp");
  });

  test("does not touch non-channel keys", () => {
    expect(redactConfigValue("delivery.default_channel", "email")).toBe("email");
  });

  test("tolerates non-JSON and null values", () => {
    expect(redactConfigValue("channel.email", "not json")).toBe("not json");
    expect(redactConfigValue("channel.email", null)).toBe(null);
  });
});

describe("redactConfigMap", () => {
  test("masks secrets across every key", () => {
    const m = redactConfigMap({ "channel.email": JSON.stringify({ app_password: "x" }), "delivery.mode": "mira" });
    expect(JSON.parse(m["channel.email"]).app_password).toBe("***");
    expect(m["delivery.mode"]).toBe("mira");
  });
});

describe("resolveSecret", () => {
  test("reads file: and strips the trailing newline", () => {
    const p = "/tmp/_mira_secret_test_" + process.pid;
    writeFileSync(p, "topsecret\n");
    try { expect(resolveSecret("file:" + p)).toBe("topsecret"); } finally { rmSync(p); }
  });

  test("reads env:", () => {
    process.env._MIRA_TEST_PW = "envpass";
    expect(resolveSecret("env:_MIRA_TEST_PW")).toBe("envpass");
  });

  test("passes a literal through unchanged (back-compat)", () => {
    expect(resolveSecret("plain-literal")).toBe("plain-literal");
  });

  test("throws on a missing secret file", () => {
    expect(() => resolveSecret("file:/nonexistent/path/xyz")).toThrow();
  });

  test("throws on an unset env var", () => {
    delete process.env._MIRA_UNSET_PW;
    expect(() => resolveSecret("env:_MIRA_UNSET_PW")).toThrow();
  });
});
