import { describe, expect, it } from "vitest";
import { passwordStrength } from "./passwordStrength";

/**
 * The strength reading under the signup password: a hint about length and
 * variety, never the rule. Below twelve characters it is weak whatever the
 * mix; above it, variety and length move it up.
 */
describe("passwordStrength", () => {
  it("says nothing for an empty field", () => {
    expect(passwordStrength("")).toEqual({ score: 0, label: "", hints: [] });
  });

  it("is weak below the twelve-character rule, and leaves the length to the field's own hint", () => {
    const short = passwordStrength("Ab1!Ab1!");
    expect(short.score).toBe(1);
    expect(short.label).toBe("Weak");
    expect(short.hints).toEqual([]);
    // Variety is still worth a word; the rule itself is said once, by the field.
    expect(passwordStrength("abcdefgh").hints).toEqual(["Mix letters with numbers or symbols."]);
  });

  it("is weak for twelve of one character or digits alone, and asks for a mix", () => {
    expect(passwordStrength("aaaaaaaaaaaa").score).toBe(1);
    const digits = passwordStrength("123456789012");
    expect(digits.score).toBe(1);
    expect(digits.hints).toContain("Mix letters with numbers or symbols.");
  });

  it("reads twelve plain letters as fair, with a hint to go longer", () => {
    const fair = passwordStrength("correcthorse");
    expect(fair.label).toBe("Weak");
    const mixed = passwordStrength("correct horse");
    expect(mixed.label).toBe("Fair");
    expect(mixed.hints).toContain("Longer is stronger: 16 characters or more.");
  });

  it("climbs to good and strong with length and variety", () => {
    expect(passwordStrength("correct horse battery").label).toBe("Good");
    expect(passwordStrength("Correct horse battery 9!").label).toBe("Strong");
    expect(passwordStrength("Correct horse battery 9!").hints).toEqual([]);
  });
});
