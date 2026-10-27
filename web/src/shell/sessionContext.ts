import { createContext } from "react";
import type { AuthConfig, Principal } from "../types";

/**
 * Who is signed in, for the pages that render both outside and inside the
 * shell. `ShellContext` is null everywhere the shell is not mounted -- and
 * that includes the gates Boot stands in front of it (email not yet
 * verified, terms to re-accept, the walkthrough), which still render the
 * front-door routes through the outlet. A person at the terms gate who
 * opens /pricing is signed in, and a card telling them to "Create account"
 * is wrong. This context says so; `gate` names which page is in their way,
 * so a call to action can send them back to it.
 */
export interface SessionContextValue {
  config: AuthConfig;
  principal: Principal;
  /** The gate standing in front of the shell, or null once it is mounted. */
  gate: "pending" | "terms" | "onboarding" | null;
}

export const SessionContext = createContext<SessionContextValue | null>(null);
