import { describe, expect, it } from "vitest";
import { DEVICE_PATH, JOIN_PATH, onboardingWaits } from "./frontDoor";

describe("onboardingWaits", () => {
  it("lets a device approval or an invite through ahead of the walkthrough", () => {
    expect(onboardingWaits(DEVICE_PATH)).toBe(true);
    expect(onboardingWaits(`${JOIN_PATH}/`)).toBe(true);
  });

  it("keeps the walkthrough in front of everything else", () => {
    expect(onboardingWaits("/")).toBe(false);
    expect(onboardingWaits("/apps/chat")).toBe(false);
    expect(onboardingWaits("/devices")).toBe(false);
  });
});
