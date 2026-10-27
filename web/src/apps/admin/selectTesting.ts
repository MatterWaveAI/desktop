import { act } from "react";
import { vi } from "vitest";

/**
 * Driving the styled select (ui/select's SimpleSelect) from a test the way a
 * person does: the trigger is a combobox button, the list opens from the
 * keyboard, and an option is chosen by the label it shows. The chosen value
 * itself is on the hidden input Base UI renders beside the trigger, which is
 * what a form would submit.
 */

/** The select in `scope`, by its accessible name when one is given. */
export function combobox(scope: ParentNode, name?: string): HTMLElement {
  const all = [...scope.querySelectorAll<HTMLElement>("[role=combobox][data-slot=select-trigger]")];
  const found = name === undefined ? all[0] : all.find((el) => accessibleName(el) === name);
  if (!found) throw new Error(`no select ${name ?? ""}`.trim());
  return found;
}

function accessibleName(el: HTMLElement): string {
  const label = el.getAttribute("aria-label");
  if (label) return label;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  if (el.id) return document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() ?? "";
  return "";
}

/** The value the select holds: "" when nothing is chosen. */
export function selectedValue(trigger: HTMLElement): string {
  const input = trigger.nextElementSibling;
  return input instanceof HTMLInputElement ? input.value : "";
}

async function open(trigger: HTMLElement): Promise<HTMLElement[]> {
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  let options: HTMLElement[] = [];
  await vi.waitFor(() => {
    // Only the open list's: a list just closed can still be in the document
    // for a moment on its way out.
    options = [
      ...document.querySelectorAll<HTMLElement>("[data-slot=select-content][data-open] [role=option]"),
    ];
    if (options.length === 0) throw new Error("the list did not open");
  });
  return options;
}

/** Open the list and choose the option showing `label`. */
export async function chooseOption(trigger: HTMLElement, label: string): Promise<void> {
  const options = await open(trigger);
  const option = options.find((o) => o.textContent === label);
  if (!option) {
    throw new Error(`no option "${label}" in ${options.map((o) => o.textContent).join(", ")}`);
  }
  await act(async () => {
    option.click();
  });
}

/** The labels the list offers, read by opening it and closing it again. */
export async function optionLabels(trigger: HTMLElement): Promise<string[]> {
  const labels = (await open(trigger)).map((o) => o.textContent ?? "");
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  return labels;
}
