/**
 * The second factor's data: the API shapes the login step and the Account
 * pane's Security section read, and the two field rules. Functions and
 * types only, so MfaPage.tsx keeps fast refresh (authForms.ts is the same
 * split for the other front-door forms).
 */

export type MfaMode = "challenge" | "enrol";

/** What `/api/me/mfa/totp/start` and `/api/auth/mfa/enrol/start` answer. */
export interface TotpEnrolment {
  secret: string;
  uri: string;
  /** An SVG data URI of the otpauth URI, for an `<img>`. */
  qr_svg: string;
}

/** `GET /api/me/mfa`: what the Security section shows. */
export interface MfaState {
  totp_enrolled: boolean;
  recovery_codes_left: number;
  /** The org's policy; while true the authenticator cannot be removed here. */
  org_requires_mfa: boolean;
}

/** Six digits, with the spaces people type between the halves allowed. */
export function validateTotpCode(code: string): string | undefined {
  const digits = code.replace(/\s+/g, "");
  if (digits === "") return "Enter the code from your authenticator app.";
  if (!/^\d{6}$|^\d{8}$/.test(digits)) return "The code is the six digits the app shows.";
  return undefined;
}

export function validateRecoveryCode(code: string): string | undefined {
  if (code.trim() === "") return "Enter one of your recovery codes.";
  return undefined;
}

/** The code as the API takes it: the digits, nothing else. */
export function normalizeTotpCode(code: string): string {
  return code.replace(/\s+/g, "");
}

export const RECOVERY_FILENAME = "matterwave-recovery-codes.txt";
