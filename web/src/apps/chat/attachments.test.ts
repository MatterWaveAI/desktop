import { describe, expect, it } from "vitest";
import {
  ACCEPTED_TYPES,
  ACCEPT_ATTRIBUTE,
  type AttachmentLimits,
  type PendingAttachment,
  type UploadedAttachment,
  anyFailed,
  anyImage,
  anyUploading,
  dragHasFiles,
  filesFromPaste,
  humanSize,
  uploadFailureText,
  isImageType,
  localTypeOf,
  namedForPaste,
  precheck,
  readyIds,
} from "./attachments";

const LIMITS: AttachmentLimits = {
  max_upload_bytes: 10 * 1024 * 1024,
  quota_bytes: 100 * 1024 * 1024,
  quota_used_bytes: 0,
  quota_remaining_bytes: 100 * 1024 * 1024,
};

function file(name: string, size: number, type = ""): File {
  const blob = new Blob([new Uint8Array(size)], { type });
  return new File([blob], name, { type });
}

function uploaded(partial: Partial<UploadedAttachment> = {}): UploadedAttachment {
  return {
    id: "a-1",
    filename: "shot.png",
    content_type: "image/png",
    size_bytes: 1024,
    scan_status: "clean",
    created_at: "2026-01-01T00:00:00Z",
    message_id: null,
    extract_truncated: false,
    ...partial,
  };
}

describe("precheck", () => {
  it("refuses an empty file", () => {
    expect(precheck(file("empty.png", 0, "image/png"), LIMITS)).toMatch(/is empty/);
  });

  it("refuses a type the OS positively states and the allowlist excludes", () => {
    const refusal = precheck(file("clip.mp4", 1024, "video/mp4"), LIMITS);
    expect(refusal).toMatch(/not a kind of file/);
    // The refusal names what IS accepted, so it is actionable.
    expect(refusal).toMatch(/PNG, JPEG, GIF, WebP/);
  });

  it("allows a file whose type the OS does not state", () => {
    // `File.type` is "" for ordinary files on ordinary machines (no registry
    // entry for the extension). Refusing on that would refuse real files; the
    // server decides from the bytes.
    expect(precheck(file("notes.md", 1024), LIMITS)).toBeNull();
    expect(precheck(file("whatever", 1024), LIMITS)).toBeNull();
  });

  it("refuses a file over the per-upload cap and names the real cap", () => {
    const refusal = precheck(file("big.png", 11 * 1024 * 1024, "image/png"), LIMITS);
    // The number is the API's, not a constant in the client.
    expect(refusal).toMatch(/10 MB limit/);
    expect(refusal).toMatch(/11 MB/);
  });

  it("refuses a file that would exceed the remaining quota, naming both numbers", () => {
    const nearlyFull: AttachmentLimits = {
      ...LIMITS,
      quota_used_bytes: 99 * 1024 * 1024,
      quota_remaining_bytes: 1024 * 1024,
    };
    const refusal = precheck(file("shot.png", 2 * 1024 * 1024, "image/png"), nearlyFull);
    expect(refusal).toMatch(/1 MB left/);
    expect(refusal).toMatch(/100 MB attachment quota/);
  });

  it("skips the size checks when the limits have not loaded", () => {
    // The whole reason `/api/attachments/limits/me` exists is that the client
    // and server cannot disagree. Guessing a cap here would be that bug.
    expect(precheck(file("huge.png", 500 * 1024 * 1024, "image/png"), null)).toBeNull();
  });

  it("still refuses a bad type with no limits loaded", () => {
    expect(precheck(file("clip.mp4", 10, "video/mp4"), null)).toMatch(/not a kind of file/);
  });
});

describe("humanSize", () => {
  it("matches the units the server's messages use", () => {
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(1024)).toBe("1 KB");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(10 * 1024 * 1024)).toBe("10 MB");
    expect(humanSize(100 * 1024 * 1024)).toBe("100 MB");
  });

  it("drops the decimal above 10 so the string stays short", () => {
    expect(humanSize(Math.round(9.44 * 1024 * 1024))).toBe("9.4 MB");
    expect(humanSize(Math.round(94.4 * 1024 * 1024))).toBe("94 MB");
  });
});

describe("localTypeOf", () => {
  it("reads the declared type when there is one", () => {
    expect(localTypeOf(file("a.png", 1, "image/PNG"))).toBe("image/png");
  });

  it("falls back to the extension for the types Windows has no entry for", () => {
    // Measured: a .md file arrives with type "" on Windows, so a types-only
    // check would treat Markdown as unknown.
    expect(localTypeOf(file("notes.md", 1))).toBe("text/markdown");
    expect(localTypeOf(file("log.txt", 1))).toBe("text/plain");
  });

  it("leaves a genuinely unknown file unknown rather than guessing", () => {
    expect(localTypeOf(file("data.bin", 1))).toBe("");
  });
});

describe("the type allowlist", () => {
  it("mirrors the server's sniff.ALLOWED exactly", () => {
    // If this drifts, the client refuses something the server accepts (or
    // worse, promises something it does not). The server is the authority;
    // this test is what keeps the copy honest.
    expect([...ACCEPTED_TYPES].sort()).toEqual(
      [
        "application/pdf",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
        "text/markdown",
        "text/plain",
      ].sort(),
    );
  });

  it("names extensions in `accept` as well as types", () => {
    // A types-only `accept` hides .md files from the OS picker entirely.
    expect(ACCEPT_ATTRIBUTE).toContain(".md");
    expect(ACCEPT_ATTRIBUTE).toContain("application/pdf");
  });

  it("classifies only the four vision types as images", () => {
    expect(isImageType("image/png")).toBe(true);
    expect(isImageType("IMAGE/JPEG")).toBe(true);
    expect(isImageType("image/svg+xml")).toBe(false);
    expect(isImageType("application/pdf")).toBe(false);
  });
});

describe("namedForPaste", () => {
  it("renames the generic name a pasted screenshot arrives with", () => {
    const at = new Date(2026, 8, 30, 14, 3, 11);
    const renamed = namedForPaste(file("image.png", 10, "image/png"), at);
    expect(renamed.name).toBe("pasted-20260930140311.png");
    expect(renamed.type).toBe("image/png");
  });

  it("renames a nameless paste", () => {
    const renamed = namedForPaste(file("", 10, "image/jpeg"), new Date(2026, 0, 1));
    expect(renamed.name).toMatch(/^pasted-\d{14}\.jpg$/);
  });

  it("keeps a real filename the user chose", () => {
    const kept = namedForPaste(file("budget-q3.png", 10, "image/png"));
    expect(kept.name).toBe("budget-q3.png");
  });
});

describe("filesFromPaste", () => {
  /** A minimal DataTransfer stand-in; jsdom's clipboard events carry none. */
  function clipboard(items: Array<{ kind: string; file: File | null }>): DataTransfer {
    return {
      items: items.map((item) => ({
        kind: item.kind,
        type: item.file?.type ?? "text/plain",
        getAsFile: () => item.file,
      })),
      types: items.map((item) => (item.kind === "file" ? "Files" : "text/plain")),
    } as unknown as DataTransfer;
  }

  it("takes the files", () => {
    const shot = file("image.png", 10, "image/png");
    expect(filesFromPaste(clipboard([{ kind: "file", file: shot }]))).toEqual([shot]);
  });

  it("ignores a text paste, so ordinary Ctrl+V is untouched", () => {
    // The bug this prevents: reading `text/plain` items as files turns every
    // paste of copied text into a .txt attachment.
    expect(filesFromPaste(clipboard([{ kind: "string", file: null }]))).toEqual([]);
  });

  it("takes only the file from a mixed clipboard", () => {
    // A copied image often arrives with an HTML representation beside it.
    const shot = file("image.png", 10, "image/png");
    const files = filesFromPaste(
      clipboard([
        { kind: "string", file: null },
        { kind: "file", file: shot },
      ]),
    );
    expect(files).toEqual([shot]);
  });

  it("is empty for a clipboard-less event", () => {
    expect(filesFromPaste(null)).toEqual([]);
  });
});

describe("dragHasFiles", () => {
  it("reads `types`, which is populated during dragover", () => {
    // `items` is deliberately withheld by the browser until drop, so a
    // handler that waits for readable items never shows a drop target.
    const transfer = { types: ["Files"], items: [] } as unknown as DataTransfer;
    expect(dragHasFiles(transfer)).toBe(true);
  });

  it("is false for a text drag", () => {
    const transfer = { types: ["text/plain"], items: [] } as unknown as DataTransfer;
    expect(dragHasFiles(transfer)).toBe(false);
  });

  it("is false with no transfer", () => {
    expect(dragHasFiles(null)).toBe(false);
  });
});

describe("the pending list", () => {
  const uploadingEntry: PendingAttachment = {
    status: "uploading",
    key: "k1",
    filename: "shot.png",
    size_bytes: 10,
    local_type: "image/png",
    progress: 40,
    abort: () => undefined,
  };
  const readyImage: PendingAttachment = {
    status: "ready",
    key: "k2",
    attachment: uploaded({ id: "a-2" }),
  };
  const readyDoc: PendingAttachment = {
    status: "ready",
    key: "k3",
    attachment: uploaded({ id: "a-3", content_type: "application/pdf", filename: "c.pdf" }),
  };
  const failedEntry: PendingAttachment = {
    status: "failed",
    key: "k4",
    filename: "big.png",
    size_bytes: 10,
    local_type: "image/png",
    reason: "too big",
    file: file("big.png", 10, "image/png"),
  };

  it("sends only the ids of entries that finished uploading", () => {
    // A failed or in-flight upload has no server id, so it cannot be sent.
    // The message goes without it rather than with a fabricated reference.
    expect(readyIds([uploadingEntry, readyImage, readyDoc, failedEntry])).toEqual(["a-2", "a-3"]);
  });

  it("knows when something is still uploading", () => {
    expect(anyUploading([uploadingEntry, readyImage])).toBe(true);
    expect(anyUploading([readyImage, failedEntry])).toBe(false);
  });

  it("sees an image whether it is uploaded yet or not", () => {
    // The vision gate has to answer before the upload, so it reads the local
    // type for an in-flight entry and the sniffed type for a finished one.
    expect(anyImage([uploadingEntry])).toBe(true);
    expect(anyImage([readyImage])).toBe(true);
    expect(anyImage([readyDoc])).toBe(false);
  });
});

describe("an upload's failure, in words", () => {
  it("keeps the server's own reason for a refusal: it names the real cap", () => {
    expect(uploadFailureText(JSON.stringify({ detail: "Larger than the 10 MB limit." }), 413)).toBe(
      "Larger than the 10 MB limit.",
    );
  });

  it("never shows a server error's raw detail", () => {
    const text = uploadFailureText(JSON.stringify({ detail: "Internal server error" }), 500);
    expect(text).not.toMatch(/internal server error/i);
    expect(text).toMatch(/try again/i);
    expect(uploadFailureText("<html>bad gateway</html>", 502)).toMatch(/try again/i);
  });
});

describe("a failed chip", () => {
  it("is known, so Send can refuse to drop it silently", () => {
    const failed = {
      status: "failed",
      key: "k",
      filename: "a.png",
      size_bytes: 1,
      local_type: "image/png",
      reason: "x",
      file: new File(["x"], "a.png"),
      preview: null,
    } as unknown as PendingAttachment;
    expect(anyFailed([failed])).toBe(true);
    expect(anyFailed([])).toBe(false);
  });
});
