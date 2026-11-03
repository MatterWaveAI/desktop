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

  for (const file of files) {
    it(`${file} runs every action at a commit, not a movable tag`, () => {
      const doc = parse(fs.readFileSync(path.join(WORKFLOWS, file), "utf8"));
      const uses = Object.values(doc.jobs).flatMap((job) => (job.steps ?? []).map((step) => step.uses).filter(Boolean));
      assert.ok(uses.length > 0);
      assert.deepEqual(
        uses.filter((ref) => !/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/.test(ref)),
        [],
      );
    });

    it(`${file} grants the token read access unless a job asks for more`, () => {
      const doc = parse(fs.readFileSync(path.join(WORKFLOWS, file), "utf8"));
      assert.deepEqual(doc.permissions, { contents: "read" });
    });
  }

  it("have code owners for every path, and for the workflows themselves", () => {
    const owners = fs
      .readFileSync(fileURLToPath(new URL("../.github/CODEOWNERS", import.meta.url)), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => line.trim().split(/\s+/));
    for (const [pattern, ...who] of owners) assert.ok(who.length > 0 && who.every((w) => w.startsWith("@")), pattern);
    assert.ok(owners.some(([pattern]) => pattern === "*"), "a default owner");
    assert.ok(owners.some(([pattern]) => pattern === "/.github/"), "owners for .github/");
  });

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

  it("release.yml verifies the tagged commit is an ancestor of origin/main before building", () => {
    const doc = parse(fs.readFileSync(path.join(WORKFLOWS, "release.yml"), "utf8"));
    const prepare = doc.jobs?.prepare;
    assert.ok(prepare, "release.yml must define jobs.prepare");
    assert.equal(doc.jobs?.build?.needs, "prepare", "jobs.build must depend on jobs.prepare");

    const checkoutStep = (prepare.steps ?? []).find(
      (s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"),
    );
    assert.ok(checkoutStep, "prepare must check out the repository");
    assert.equal(checkoutStep.with?.["fetch-depth"], 0, "prepare checkout must use fetch-depth: 0");

    const guardStep = (prepare.steps ?? []).find(
      (s) => typeof s.run === "string" && s.run.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main'),
    );
    assert.ok(guardStep, 'prepare must verify git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    assert.match(guardStep.run, /git fetch origin main/);
  });

  it("RELEASING.md documents merging develop into main, manifest version bumps, tagging, and release verification", () => {
    const releasingPath = fileURLToPath(new URL("../RELEASING.md", import.meta.url));
    assert.ok(fs.existsSync(releasingPath), "RELEASING.md must exist at the repo root");
    const text = fs.readFileSync(releasingPath, "utf8");
    assert.match(text, /develop/);
    assert.match(text, /main/);
    assert.match(text, /package\.json/);
    assert.match(text, /src-tauri\/Cargo\.toml/);
    assert.match(text, /src-tauri\/tauri\.conf\.json/);
    assert.match(text, /CHANGELOG\.md/);
    assert.match(text, /scripts\/release-check\.mjs/);
    assert.match(text, /git merge-base --is-ancestor/);
    assert.match(text, /origin\/main/);
  });
});
