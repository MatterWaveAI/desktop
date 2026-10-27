export interface SSEEvent {
  event: string;
  data: string;
}

function parseFrame(frame: string): SSEEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const raw of frame.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const evt = parseFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (evt) yield evt;
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Cancel if we are leaving early (stop button, thrown error) so the
    // connection to the API is actually closed, not just abandoned.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
