/**
 * Bounded request-body reading — shared by both runtimes.
 *
 * `await req.text()` buffers the ENTIRE body before any length check can run,
 * so a chunked / no-Content-Length request could balloon process memory (the
 * single-process Deno host has a 256MB cgroup cap) before being rejected.
 * This reads the stream chunk-by-chunk and aborts the moment the running
 * total crosses the cap — memory use is bounded by maxBytes regardless of
 * what the client declares or streams.
 */

/** Read at most maxBytes of the body; returns null when the cap is exceeded. */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<string | null> {
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch { /* already errored/closed — the rejection below still stands */ }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ok */ }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
