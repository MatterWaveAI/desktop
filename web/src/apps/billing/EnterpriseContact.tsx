import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { apiFetch } from "../../lib/api";
import { PROSE_LINK_CLASS, failureMessage } from "../../shell/authForms";

const SALES_EMAIL = "sales@matterwave.dev";

/** What `POST /api/enterprise/contact` takes; `website` is the field no person fills in. */
interface EnterpriseContactBody {
  name: string;
  email: string;
  company: string;
  seats?: number;
  phone?: string;
  message?: string;
  page: string;
  website?: string;
}

function sendEnterpriseContact(body: EnterpriseContactBody): Promise<{ status: string }> {
  return apiFetch<{ status: string }>("/api/enterprise/contact", { method: "POST", json: body });
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * "Talk to sales": invoicing, negotiated terms, more seats than a plan
 * lists. The request becomes a Lead in the CRM through the API's outbox, so
 * a CRM that is down loses nothing. On a deployment without a CRM the API
 * answers 503 and the form says where to write instead.
 */
export function EnterpriseContact() {
  const [state, setState] = useState<"idle" | "sending" | "sent" | { error: string }>("idle");
  const ids = { name: useId(), email: useId(), company: useId(), seats: useId(), phone: useId(), message: useId() };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const seats = Number.parseInt(field(form, "seats"), 10);
    const body: EnterpriseContactBody = {
      name: field(form, "name"),
      email: field(form, "email"),
      company: field(form, "company"),
      page: window.location.pathname,
      ...(Number.isFinite(seats) && seats > 0 ? { seats } : {}),
      ...(field(form, "phone") ? { phone: field(form, "phone") } : {}),
      ...(field(form, "message") ? { message: field(form, "message") } : {}),
      ...(field(form, "website") ? { website: field(form, "website") } : {}),
    };
    if (!body.name || !body.email || !body.company) {
      setState({ error: "Your name, work email and company are needed." });
      return;
    }
    setState("sending");
    try {
      await sendEnterpriseContact(body);
      setState("sent");
    } catch (err) {
      setState({ error: failureMessage(err) });
    }
  }

  return (
    <section aria-labelledby="enterprise-contact" className="mt-12 rounded-xl border border-mw-border bg-mw-surface-raised p-5 sm:p-7">
      <h2 id="enterprise-contact" className="font-display text-display-sm">
        Enterprise and invoicing
      </h2>
      <p className="mt-1 text-sm text-mw-text-muted">
        Invoice billing on net terms with a PO number, negotiated allowances and seats, single sign-on, and a
        late-payment policy set for your organisation. Tell us what you need and sales will be in touch.
      </p>
      {state === "sent" ? (
        <p role="status" className="mt-3 text-sm font-medium">
          Thanks, we have your request. Sales will reply by email, usually within one business day.
        </p>
      ) : (
        <form onSubmit={(event) => void handleSubmit(event)} className="mt-3 grid gap-3 sm:grid-cols-2" noValidate>
          <label htmlFor={ids.name} className="flex flex-col gap-1 text-sm">
            Name
            <Input id={ids.name} name="name" autoComplete="name" required maxLength={120} />
          </label>
          <label htmlFor={ids.email} className="flex flex-col gap-1 text-sm">
            Work email
            <Input id={ids.email} name="email" type="email" autoComplete="email" required maxLength={254} />
          </label>
          <label htmlFor={ids.company} className="flex flex-col gap-1 text-sm">
            Company
            <Input id={ids.company} name="company" autoComplete="organization" required maxLength={200} />
          </label>
          <label htmlFor={ids.seats} className="flex flex-col gap-1 text-sm">
            Seats (roughly)
            <Input id={ids.seats} name="seats" type="number" min={1} inputMode="numeric" />
          </label>
          <label htmlFor={ids.phone} className="flex flex-col gap-1 text-sm">
            Phone (optional)
            <Input id={ids.phone} name="phone" type="tel" autoComplete="tel" maxLength={40} />
          </label>
          <label htmlFor={ids.message} className="flex flex-col gap-1 text-sm sm:col-span-2">
            What do you need?
            <Textarea id={ids.message} name="message" maxLength={4000} rows={3} />
          </label>
          {/* Hidden from people and from assistive technology; a bot fills it in. */}
          <div aria-hidden="true" className="sr-only">
            <label>
              Website
              <input name="website" type="text" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={state === "sending"}>
              {state === "sending" ? "Sending…" : "Contact sales"}
            </Button>
            <span className="text-sm text-mw-text-muted">
              Or email{" "}
              <a href={`mailto:${SALES_EMAIL}`} className={PROSE_LINK_CLASS}>
                {SALES_EMAIL}
              </a>
            </span>
          </div>
          {typeof state === "object" && (
            <p role="alert" className="text-sm text-mw-danger sm:col-span-2">
              {state.error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
