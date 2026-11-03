import { t } from "@lingui/core/macro";
import type { AuthConfig } from "../types";
import { LINK_CLASS } from "./authForms";

/**
 * The small shared pieces of the front door that are data, not components:
 * the tap-target classes the forms share, and the links a deployment may
 * or may not have.
 */

/**
 * A text link tall enough to tap: 24px on a phone (the audit measured the
 * forms' links at 18-20). `inline-flex` so the height applies to an inline
 * anchor without changing how it sits beside its sentence.
 */
export const TAP_LINK_CLASS = `${LINK_CLASS} inline-flex min-h-6 items-center`;

/** The width every front-door page lines up on: the header, the sections, the footer. */
export const FRONT_DOOR_WIDTH = "mx-auto w-full max-w-6xl px-4 sm:px-7";

/** A checkbox a thumb can find: 20px, and a label that is the hit area. */
export const CHECKBOX_CLASS = "mt-0.5 size-5 shrink-0 accent-mw-accent";
export const CHECKBOX_LABEL_CLASS = "flex min-h-6 cursor-pointer items-start gap-2.5 py-1 text-sm";

/**
 * The support address the public site publishes (site/business/index.md).
 * Used only when the deployment names no support URL of its own.
 */
export const SUPPORT_EMAIL = "support@matterwave.dev";

export interface FooterLink {
  kind: "contact" | "status";
  label: string;
  href: string;
  /** Opens elsewhere: another origin, or a mail client. */
  external: boolean;
}

/**
 * Contact and Status, from what the deployment configured: Contact is the
 * support URL and Status the status page, each only when named. With
 * `fallbackContact` (the landing footer) Contact falls back to the published
 * address, so the front page always has a way to reach a person. Nothing
 * here invents an address.
 */
export function supportLinks(
  config: Pick<AuthConfig, "support_url" | "status_url"> | null | undefined,
  fallbackContact = false,
): FooterLink[] {
  const links: FooterLink[] = [];
  const contact = config?.support_url ?? (fallbackContact ? `mailto:${SUPPORT_EMAIL}` : undefined);
  if (contact) links.push({ kind: "contact", label: t`Contact`, href: contact, external: true });
  if (config?.status_url) {
    links.push({ kind: "status", label: t`Status`, href: config.status_url, external: true });
  }
  return links;
}
