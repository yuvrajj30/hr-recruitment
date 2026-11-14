// Reads a JSON request body safely: the right content type, a hard size limit that does not
// depend on what the sender claims, and valid UTF-8 / JSON. Nothing here looks at the content itself.

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 | 415; code: "invalid_request" | "payload_too_large" | "unsupported_media_type" };

const fail = (status: 400 | 413 | 415, code: "invalid_request" | "payload_too_large" | "unsupported_media_type"): BodyResult => ({
  ok: false,
  status,
  code,
});

export async function readJsonBody(
  request: { headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<BodyResult> {
  const mime = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime !== "application/json") return fail(415, "unsupported_media_type");

  // A sender can announce a huge body up front; refuse before reading anything.
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > maxBytes) return fail(413, "payload_too_large");

  if (!request.body) return fail(400, "invalid_request");

  // The announced size can be missing or a lie, so the real size is counted while reading.
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return fail(413, "payload_too_large");
    }
    chunks.push(value);
  }

  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return fail(400, "invalid_request");
  }
}
