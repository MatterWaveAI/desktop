import { PASSWORD_MIN_LENGTH } from "./authForms";

/**
 * A rough read of a password as it is typed: long enough, and made of more
 * than one kind of character. It is a hint, not the rule -- the rule is the
 * API's (twelve characters, `validatePassword`) -- so a weak-looking
 * password that meets the rule is still accepted, and nothing here is sent
 * anywhere. No dictionary and no library: length and variety are what a
 * person can act on while typing. Below the rule it says nothing about
 * length: the field's own hint ("At least 12 characters.") already does,
 * and a second line saying the same under one field read as two rules.
 */
export interface PasswordStrength {
  /** 0 for empty, 1 weak, 2 fair, 3 good, 4 strong. */
  score: 0 | 1 | 2 | 3 | 4;
  label: "" | "Weak" | "Fair" | "Good" | "Strong";
  /** What would make it stronger, in the order worth doing. */
  hints: string[];
}

const LABELS = ["", "Weak", "Fair", "Good", "Strong"] as const;

export function passwordStrength(password: string): PasswordStrength {
  if (password === "") return { score: 0, label: "", hints: [] };
  const kinds =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/\d/.test(password)) +
    Number(/[^A-Za-z0-9]/.test(password));
  const hints: string[] = [];
  if (password.length >= PASSWORD_MIN_LENGTH && password.length < 16) {
    hints.push("Longer is stronger: 16 characters or more.");
  }
  if (kinds < 2) hints.push("Mix letters with numbers or symbols.");
  // One character repeated, or digits alone: long, but not for long.
  const samey = /^(.)\1+$/.test(password) || /^\d+$/.test(password);

  let points = 0;
  if (password.length >= PASSWORD_MIN_LENGTH) points += 1;
  if (password.length >= 16) points += 1;
  if (password.length >= 24) points += 1;
  if (kinds >= 2) points += 1;
  if (kinds >= 3) points += 1;
  if (samey) points = Math.min(points, 1);
  // Below the rule it is weak whatever else is true: the API will refuse it.
  if (password.length < PASSWORD_MIN_LENGTH) points = Math.min(points, 1);

  const score: 1 | 2 | 3 | 4 = points <= 1 ? 1 : points === 2 ? 2 : points === 3 ? 3 : 4;
  return { score, label: LABELS[score], hints };
}
