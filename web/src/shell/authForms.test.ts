import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { NETWORK_MESSAGE, failureMessage, splitValidationDetail } from "./authForms";

function unprocessable(detail: unknown): ApiError {
  return new ApiError(422, "Unprocessable", { detail });
}

describe("failureMessage", () => {
  it("says the network failed when the request never got an answer", () => {
    expect(failureMessage(new TypeError("fetch failed"))).toBe(NETWORK_MESSAGE);
  });

  it("uses a string detail as it is", () => {
    expect(failureMessage(new ApiError(409, "That domain is already claimed."))).toBe(
      "That domain is already claimed.",
    );
  });

  it("turns pydantic's list into sentences a person reads, naming the field", () => {
    const err = unprocessable([
      { loc: ["body", "domain"], msg: "Value error, must be a domain like example.com", type: "value_error" },
      { loc: ["body", "display_name"], msg: "String should have at most 120 characters", type: "string_too_long" },
      { loc: ["body", "issuer"], msg: "Field required", type: "missing" },
    ]);

    expect(failureMessage(err)).toBe(
      "Domain: must be a domain like example.com. " +
        "Display name: use at most 120 characters. " +
        "Issuer: this is required.",
    );
  });

  it("never shows pydantic's own prefixes or wording", () => {
    const err = unprocessable([
      { loc: ["body", "name"], msg: "String should have at least 1 character", type: "string_too_short" },
    ]);
    const message = failureMessage(err);
    expect(message).not.toMatch(/String should|Value error/);
    expect(message).toBe("Name: enter at least 1 character.");
  });

  it("leaves a body-level item without a field name", () => {
    const err = unprocessable([{ loc: ["body"], msg: "Input should be a valid dictionary", type: "dict_type" }]);
    expect(failureMessage(err)).toBe("The form could not be read. Reload the page and try again.");
  });
});

describe("splitValidationDetail", () => {
  it("puts each readable message under its field and the rest in other", () => {
    const err = unprocessable([
      { loc: ["body", "domain"], msg: "Value error, That domain is reserved.", type: "value_error" },
      { loc: ["body", "client_id"], msg: "String should have at least 1 character", type: "string_too_short" },
    ]);

    expect(splitValidationDetail(err, ["domain"] as const)).toEqual({
      fields: { domain: "That domain is reserved." },
      other: ["Client id: enter at least 1 character."],
    });
  });
});
