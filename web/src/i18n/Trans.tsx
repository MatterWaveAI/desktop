import { LinguiContext } from "@lingui/react";
import { TransNoContext, type TransProps } from "@lingui/react/server";
import { useContext } from "react";
import { i18n } from "./runtime";

/** The `<Trans>` the macro compiles to; runtime.ts says why it tolerates a missing provider. */
export function Trans(props: TransProps) {
  const context = useContext(LinguiContext);
  return (
    <TransNoContext
      {...props}
      lingui={{ i18n: context?.i18n ?? i18n, defaultComponent: context?.defaultComponent }}
    />
  );
}
