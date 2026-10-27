/**
 * What changed in each version of the terms, newest first, for the
 * re-accept page to show beside "the terms have changed". The version
 * strings are the API's `TERMS_VERSION` values (account.py); the API still
 * decides which version is in force, this list only describes them. When
 * the terms are revised, add an entry here with the new version and a plain
 * line on what moved -- the owner edits this list, nothing derives it.
 */
export interface TermsChange {
  version: string;
  /** ISO date the text changed. */
  date: string;
  /** One or two plain sentences on what is different for the reader. */
  summary: string;
}

export const TERMS_CHANGES: readonly TermsChange[] = [
  {
    version: "2026-10",
    date: "2026-10-22",
    summary:
      "Section 5 now describes the self-serve plans: paid monthly plans continue past the allowance at list price up to an overage cap, annual plans stop at the allowance, and a cancelled subscription runs to the end of the period paid for.",
  },
  {
    version: "2026-09",
    date: "2026-09-27",
    summary: "The first version of the terms.",
  },
];

/**
 * The entries newer than the version a person accepted, newest first. With
 * no accepted version (an account that predates the stamp) every entry is
 * new to them. Versions are `YYYY-MM`, so a string comparison orders them.
 */
export function termsChangesSince(accepted: string | null | undefined): TermsChange[] {
  return TERMS_CHANGES.filter((change) => !accepted || change.version > accepted);
}
