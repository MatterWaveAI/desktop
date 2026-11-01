// node --test scripts/: the workflow files GitHub would refuse before running
// a single step. Expression contexts are only available in some places
// (https://docs.github.com/en/actions/learn-github-actions/contexts#context-availability);
// a `runner.temp` in a job's `env`, for one, fails the whole workflow in 0 s
// with "workflow file issue" while every local check stays green.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const WORKFLOWS = fileURLToPath(new URL("../.github/workflows/", import.meta.url));

/** The contexts each key may read, per GitHub's availability table. */
const WORKFLOW_ENV = ["github", "secrets", "inputs", "vars"];
const JOB_LEVEL = ["github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"];
const STEP_LEVEL = [...JOB_LEVEL, "env", "job", "runner", "steps"];
const JOB_IF = ["github", "needs", "vars", "inputs"];

/** Every `${{ }}` expression in a value, with the contexts it names. */
function contextsIn(value) {
  const found = [];
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  for (const [, expr] of text.matchAll(/\$\{\{(.*?)\}\}/gs)) {
    // Quoted strings first, so 'a.b' inside one is not read as a context.
    const code = expr.replace(/'[^']*'/g, "''");
    for (const [, name] of code.matchAll(/(?<![\w.-])([a-z_][\w-]*)\s*\./gi)) found.push(name);
  }
  return found;
}

/** Contexts used under `value` that `allowed` does not include, as messages. */
function misuse(where, value, allowed) {
  return contextsIn(value)
    .filter((name) => !allowed.includes(name))
    .map((name) => `${where}: \`${name}\` is not available here`);
}

/** A bare `if:` is an expression too, without the `${{ }}`. */
function ifExpression(value) {
  if (typeof value !== "string") return value;
  return value.includes("${{") ? value : `\${{ ${value} }}`;
}

export function workflowProblems(doc) {
  const problems = [...misuse("env", doc.env, WORKFLOW_ENV)];
  for (const [id, job] of Object.entries(doc.jobs ?? {})) {
    const at = `jobs.${id}`;
    problems.push(...misuse(`${at}.env`, job.env, JOB_LEVEL));
    problems.push(...misuse(`${at}.runs-on`, job["runs-on"], JOB_LEVEL));
    problems.push(...misuse(`${at}.strategy`, job.strategy, JOB_LEVEL));
    problems.push(...misuse(`${at}.continue-on-error`, job["continue-on-error"], JOB_LEVEL));
    problems.push(...misuse(`${at}.defaults`, job.defaults, JOB_LEVEL));
    problems.push(...misuse(`${at}.if`, ifExpression(job.if), JOB_IF));
    problems.push(...misuse(`${at}.outputs`, job.outputs, STEP_LEVEL));
    for (const [i, step] of (job.steps ?? []).entries()) {
      const name = `${at}.steps[${step.id ?? step.name ?? i}]`;
      for (const key of ["env", "with", "run", "name", "continue-on-error", "timeout-minutes", "working-directory"]) {
        problems.push(...misuse(`${name}.${key}`, step[key], STEP_LEVEL));
      }
      problems.push(...misuse(`${name}.if`, ifExpression(step.if), STEP_LEVEL));
      if (step.uses && step.run) problems.push(`${name}: both uses and run`);
      if (!step.uses && !step.run) problems.push(`${name}: neither uses nor run`);
    }
    if (!job["runs-on"] && !job.uses) problems.push(`${at}: no runs-on`);
  }
  return problems;
}

describe("the workflow files", () => {
  const files = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  it("exist", () => assert.ok(files.length > 0));

  for (const file of files) {
    it(`${file} reads contexts only where GitHub provides them`, () => {
      const doc = parse(fs.readFileSync(path.join(WORKFLOWS, file), "utf8"));
      assert.ok(doc.on, `${file} has no trigger`);
      assert.deepEqual(workflowProblems(doc), []);
    });
  }

  it("catches a runner context in a job's env", () => {
    const doc = parse(`
on: push
jobs:
  rust:
    runs-on: ubuntu-latest
    env:
      CARGO_TARGET_DIR: \${{ runner.temp }}/cargo-target
    steps:
      - run: cargo test
        env:
          OK_HERE: \${{ runner.temp }}
`);
    assert.deepEqual(workflowProblems(doc), ["jobs.rust.env: `runner` is not available here"]);
  });

  it("reads quoted strings and function calls as what they are", () => {
    const doc = parse(`
on: push
jobs:
  build:
    runs-on: \${{ matrix.os }}
    if: github.ref == 'refs/tags/v1.x'
    steps:
      - if: hashFiles('web/pnpm-lock.yaml') != ''
        run: echo "\${{ steps.signing.outputs.signed == '1' && 'a.b' || 'c.d' }}"
`);
    assert.deepEqual(workflowProblems(doc), []);
  });
});
