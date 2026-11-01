import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/**
 * What changed in each version of the terms, newest first, for the
 * re-accept page to show beside "the terms have changed". The version
 * strings are the API's `TERMS_VERSION` values (account.py); the API still
 * decides which version is in force, this list only describes them. When
 * the terms are revised, add an entry here with the new version and a plain
 * line on what moved -- the owner edits this list, nothing derives it.
 *
 * `material` must match the API's `TERMS_REVISIONS` (account.py, where the
 * rule for setting it is written; an API test compares the two): a material
 * revision stops older accounts at the accept page, a minor one shows them
 * a notice they can dismiss.
 */
export interface TermsChange {
  version: string;
  /** ISO date the text changed. */
  date: string;
  /** Whether accepting it is required before the app can be used again. */
  material: boolean;
  /** One or two plain sentences on what is different for the reader. */
  summary: string;
}

/**
 * `summary` is read when it is shown, in the language active then: the
 * list is built when the module loads, before any catalogue is.
 */
function change(
  version: string,
  date: string,
  material: boolean,
  summary: MessageDescriptor,
): TermsChange {
  return {
    version,
    date,
    material,
    get summary() {
      return i18n._(summary);
    },
  };
}

export const TERMS_CHANGES: readonly TermsChange[] = [
  change(
    "2026-10",
    "2026-10-22",
    true,
    msg`Section 5 now describes the self-serve plans: paid monthly plans continue past the allowance at list price up to an overage cap, annual plans stop at the allowance, and a cancelled subscription runs to the end of the period paid for.`,
  ),
  change("2026-09", "2026-09-27", true, msg`The first version of the terms.`),
];


/**
 * The entries newer than the version a person accepted, newest first. With
 * no accepted version (an account that predates the stamp) every entry is
 * new to them. Versions are `YYYY-MM`, so a string comparison orders them.
 */
export function termsChangesSince(accepted: string | null | undefined): TermsChange[] {
  return TERMS_CHANGES.filter((change) => !accepted || change.version > accepted);
}
