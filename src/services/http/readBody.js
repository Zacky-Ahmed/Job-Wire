// Enforce the byte ceiling while streaming; a missing/false Content-Length must
// not allow a source to allocate an unbounded response before we reject it.
export async function readBody(res, maxBytes) {
  if (Number(res.headers.get("content-length") || 0) > maxBytes) {
    throw new Error("Response too large");
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Response too large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
