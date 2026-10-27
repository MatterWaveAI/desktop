/**
 * The readable half of an unsubscribe token. The API signs
 * `<base64url(category:subject)>.<base64url(mac)>` (unsubscribe.py); the
 * first half says which mail the link is about, so the page can name it
 * before the button is pressed and refuse a link that is not even the right
 * shape without a request. Only the API's answer decides whether a token is
 * valid -- the payload is trusted for wording and nothing else.
 */

export const UNSUBSCRIBE_CATEGORIES: Record<string, { label: string; what: string }> = {
  usage_alerts: {
    label: "usage alerts",
    what: "the mail sent when your organisation nears its budget or plan allowance",
  },
  product_updates: {
    label: "product updates",
    what: "the occasional mail about new models and features",
  },
};

/** The category the token names, when it is shaped like one of ours. */
export function tokenCategory(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  try {
    const unpadded = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const payload = atob(unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4));
    const colon = payload.indexOf(":");
    if (colon <= 0 || colon === payload.length - 1) return null;
    const category = payload.slice(0, colon);
    return category in UNSUBSCRIBE_CATEGORIES ? category : null;
  } catch {
    return null;
  }
}
