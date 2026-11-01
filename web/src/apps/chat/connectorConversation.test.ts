import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import type { ConversationSource } from "../../types";
import {
  CONNECTOR_CONVERSATION_CODE,
  connectorName,
  connectorNoticeText,
  connectorSourceOfError,
  sourceLabel,
} from "./connectorConversation";

const SLACK: ConversationSource = {
  connector: "slack",
  connection_id: "conn-1",
  channel_label: "#support",
  url: "https://acme.slack.com/archives/C01/p1700000000000100",
};

describe("a connector's conversation, as text", () => {
  it("names the connector from its id and the channel as the API labels it", () => {
    expect(connectorName(SLACK)).toBe("Slack");
    expect(sourceLabel(SLACK)).toBe("Slack #support");
    expect(connectorNoticeText(SLACK)).toBe("Answered in Slack #support — reply in the thread");
  });

  it("stands without a channel, and without a connector id", () => {
    expect(sourceLabel({ ...SLACK, channel_label: null })).toBe("Slack");
    expect(connectorName({ ...SLACK, connector: "" })).toBe("its connector");
  });
});

describe("the 409 a send into a connector's conversation answers", () => {
  const refusal = {
    detail: "This conversation is answered from slack in #support; reply there.",
    code: CONNECTOR_CONVERSATION_CODE,
    source: SLACK,
    request_id: "req-1",
  };

  it("carries the thread, read off the body", () => {
    expect(connectorSourceOfError(new ApiError(409, refusal.detail, refusal, "req-1"))).toEqual(SLACK);
  });

  it("reads a field the server left out as null, never undefined", () => {
    const partial = { ...refusal, source: { connector: "slack", channel_label: "#support" } };
    expect(connectorSourceOfError(new ApiError(409, refusal.detail, partial, "req-1"))).toEqual({
      connector: "slack",
      connection_id: null,
      channel_label: "#support",
      url: null,
    });
  });

  it("is null for any other refusal: another 409, another status, not an ApiError", () => {
    expect(
      connectorSourceOfError(new ApiError(409, "A temporary conversation is not kept.", { detail: "x" })),
    ).toBeNull();
    expect(connectorSourceOfError(new ApiError(422, refusal.detail, refusal))).toBeNull();
    expect(connectorSourceOfError(new Error(refusal.detail))).toBeNull();
  });
});
