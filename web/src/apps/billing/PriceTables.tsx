import {
  formatMultiplier,
  formatUsd,
  overageSummary,
  planAllowance,
  planModelLabels,
  type ModelPrice,
  type PlanSummary,
} from "../../lib/billing";

/**
 * The price list and the plan allowances as tables, shared by /pricing and
 * the developer portal's pricing page so the two can never quote a model
 * differently. Both read `GET /api/plans` and render only what it says:
 * labels, list prices, multipliers and which plan includes which model are
 * all the API's.
 *
 * No router links in here: the developer pages render in a unit test
 * without a RouterProvider.
 */

const TABLE_CLASS = "w-full text-sm";
const TH_CLASS = "py-1.5 pr-4 text-left font-normal text-mw-text-muted";
const TD_CLASS = "py-1.5 pr-4 align-top";
const NUM_CLASS = `${TD_CLASS} tabular-nums`;

/**
 * The plans that include a model, by name, in the catalog's order (cheapest
 * first). A partner model no listed plan names says so, rather than leaving
 * an empty cell that reads like a missing value.
 */
function plansWith(model: string, plans: readonly PlanSummary[]): string {
  const names = plans.filter((plan) => plan.models.includes(model)).map((plan) => plan.name);
  if (names.length === 0) return "Only plans that name it";
  return names.length === plans.length && plans.length > 1 ? "Every plan" : names.join(", ");
}

/**
 * One price table. Callers render GRT and partner models as two tables
 * (`splitPartners`), each under its own name, so a partner model is never
 * read as one of the plan's own.
 */
export function ModelPriceTable(props: {
  name: string;
  models: readonly ModelPrice[];
  plans: readonly PlanSummary[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className={TABLE_CLASS} aria-label={props.name}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>Model</th>
            <th scope="col" className={TH_CLASS}>Multiplier</th>
            <th scope="col" className={TH_CLASS}>Input, per 1M tokens</th>
            <th scope="col" className={TH_CLASS}>Output, per 1M tokens</th>
            <th scope="col" className={TH_CLASS}>Included on</th>
          </tr>
        </thead>
        <tbody>
          {props.models.map((model) => (
            <tr key={model.id} data-model={model.id} className="border-t border-mw-border">
              <th scope="row" className={`${TD_CLASS} text-left font-medium`}>
                {model.label}
                <code className="ml-2 font-mono text-xs font-normal text-mw-text-muted">{model.id}</code>
              </th>
              <td className={NUM_CLASS}>{formatMultiplier(model.multiplier)}</td>
              <td className={NUM_CLASS}>{formatUsd(model.input_usd_per_m)}</td>
              <td className={NUM_CLASS}>{formatUsd(model.output_usd_per_m)}</td>
              <td className={TD_CLASS}>{plansWith(model.id, props.plans)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PlanAllowanceTable(props: { models: readonly ModelPrice[]; plans: readonly PlanSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className={TABLE_CLASS} aria-label="Plan allowances">
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>Plan</th>
            <th scope="col" className={TH_CLASS}>Included each month</th>
            <th scope="col" className={TH_CLASS}>Past the allowance</th>
            <th scope="col" className={TH_CLASS}>Models</th>
          </tr>
        </thead>
        <tbody>
          {props.plans.map((plan) => (
            <tr key={plan.code} data-plan={plan.code} className="border-t border-mw-border">
              <th scope="row" className={`${TD_CLASS} text-left font-medium`}>
                {plan.name}
              </th>
              <td className={NUM_CLASS}>{planAllowance(plan)}</td>
              <td className={TD_CLASS}>{overageSummary(plan)}</td>
              <td className={TD_CLASS}>{planModelLabels(plan, props.models).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
