import { describe, expect, it } from "vitest";
import { readJsonBody } from "@/lib/http/body";
import { errorResponse, jsonResponse } from "@/lib/http/responses";

const req = (body: BodyInit | null, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Request("http://localhost:3000/x", { method: "POST", headers, body });

describe("reading a JSON body", () => {
  it("accepts JSON (with or without a charset)", async () => {
    expect(await readJsonBody(req('{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
    expect(await readJsonBody(req('{"a":1}', { "content-type": "Application/JSON; charset=utf-8" }), 100)).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });
  it("refuses any other content type (415)", async () => {
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp", ""]) {
      const headers: Record<string, string> = ct ? { "content-type": ct } : {};
      expect(await readJsonBody(req('{"a":1}', headers), 100), ct).toMatchObject({ ok: false, status: 415 });
    }
  });
  it("refuses a body that announces itself as too big, before reading it (413)", async () => {
    const r = req('{"a":1}', { "content-type": "application/json", "content-length": "5000" });
    expect(await readJsonBody(r, 100)).toMatchObject({ ok: false, status: 413, code: "payload_too_large" });
  });
  it("counts the real size while reading, whatever the sender claims (413)", async () => {
    expect(await readJsonBody(req(JSON.stringify({ a: "x".repeat(500) })), 100)).toMatchObject({ ok: false, status: 413 });
    const exact = JSON.stringify({ a: "x".repeat(10) });
    expect(await readJsonBody(req(exact), Buffer.byteLength(exact))).toMatchObject({ ok: true });
    expect(await readJsonBody(req(exact), Buffer.byteLength(exact) - 1)).toMatchObject({ ok: false, status: 413 });
  });
  it("counts bytes, not characters", async () => {
    const body = JSON.stringify({ a: "é".repeat(40) }); // 2 bytes per character
    expect(await readJsonBody(req(body), 60)).toMatchObject({ ok: false, status: 413 });
  });
  it("refuses empty, broken or non-UTF-8 bodies (400)", async () => {
    for (const body of [null, "", "{", "not json", '{"a":', new Uint8Array([0xff, 0xfe, 0x7b])]) {
      expect(await readJsonBody(req(body as BodyInit | null), 100), String(body)).toMatchObject({ ok: false, status: 400, code: "invalid_request" });
    }
  });
});

describe("response helpers", () => {
  it("every response is uncacheable and carries nosniff", () => {
    for (const r of [jsonResponse({ ok: true }), errorResponse("forbidden", 403)]) {
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-type")).toContain("application/json");
    }
  });
  it("errors always have the same shape", async () => {
    const r = errorResponse("invalid_credentials", 401);
    expect(r.status).toBe(401);
    expect(await r.text()).toBe('{"error":"invalid_credentials"}');
    expect(await errorResponse("too_many_attempts", 429, { extra: { retryAfterSeconds: 30 } }).text()).toBe(
      '{"error":"too_many_attempts","retryAfterSeconds":30}',
    );
  });
  it("keeps each cookie in its own Set-Cookie header", () => {
    const r = jsonResponse({}, 200, { cookies: ["a=1; Path=/", "b=2; Path=/"] });
    expect(r.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
});
