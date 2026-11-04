---
name: iFacto.bc-saas-test-runner
description: 'Run AL unit tests against a BC SaaS sandbox using the `al runtests` CLI command. Use when: executing test codeunits after implementation, validating a feature against tests, running Red or Green phase of TDD. SaaS sandbox only — OnPrem and Production configurations are rejected.'
---

# BC SaaS Test Runner

Runs one or more AL test codeunits against a Business Central **SaaS sandbox** using the `al runtests` command from the `microsoft.dynamics.businesscentral.development.tools` dotnet CLI tool. Reads connection settings from `launch.json`, executes tests synchronously, and reports pass/fail per method.

> ⛔ **SaaS sandbox only.** This skill runs tests exclusively against a launch configuration with `"environmentType": "Sandbox"`. OnPrem and Production configurations are hard stops — see Step 1.

## When to Use

- After implementing code — run tests to confirm Green
- After writing test codeunits — publish them and run to confirm Red (TDD workflow)
- Before handing off to code review — confirm all tests pass
- Spot-checking a specific test codeunit after a bug fix

> **TDD Red Phase:** "Red" means the test codeunit **compiles, deploys, and runs** — but the test method returns FAIL. A compile error or deploy failure is **not** a valid Red state; fix the build first before considering the test Red.

## Prerequisites

- **`al` CLI tool installed** — `microsoft.dynamics.businesscentral.development.tools` must be installed as a dotnet global tool (`dotnet tool list --global` should show it). Install with: `dotnet tool install --global microsoft.dynamics.businesscentral.development.tools --prerelease`
- **App must already be deployed** to the target environment — use the `al-build-validation` skill to build and publish before running tests. This applies in both Red and Green phases: the test app must compile and deploy successfully before `al runtests` can be used
- **`.vscode/launch.json` must exist** in the project root and contain a **SaaS sandbox** configuration (`"environmentType": "Sandbox"` + `"environmentName"`)

## Command Reference

```
al runtests <codeunitId> [options]

Arguments:
  <codeunitId>               The test codeunit ID to run (e.g., 50100)

Key Options:
  --testmethods <methods>    Specific test method name(s) to run (runs all if omitted)
  --project <path>           AL project folder path — used to locate launch.json
  --company <name>           Company name (e.g., 'CRONUS International Ltd.')
  --environmentname <name>   Sandbox environment name (e.g., 'sandbox')
  --environmenttype <type>   Always 'Sandbox' for this skill
  --tenant <tenantId>        Tenant ID for multi-tenant environments
  --authentication <method>  'AAD' (default)
  --nocache                  Force re-authentication (bypass cached tokens)
```

The CLI also accepts `--server` / `--serverinstance` / `--authentication Windows` for OnPrem. **Do not use them** — this skill does not run OnPrem tests.

## Procedure

### Step 1: Validate the Environment

Read `.vscode/launch.json` from the project root.

**Only `"environmentType": "Sandbox"` is accepted.** Every other configuration is a hard stop — do not fall back, do not improvise a command, do not ask the user whether to continue anyway.

| `launch.json` configuration | Verdict |
|---|---|
| The **first** `"environmentType": "Sandbox"` configuration has `QA` (any casing) in its `"environmentName"` or `"name"` | 🛑 QA — STOP, also when it is a Sandbox |
| Has `"environmentName"` + `"environmentType": "Sandbox"` | ✅ SaaS Sandbox — proceed |
| Has `"environmentType": "Production"` | ⛔ Production — STOP |
| Has `"server"` / `"serverInstance"`, or no `"environmentType"` | ⛔ OnPrem — STOP |
| No configuration with `"environmentType": "Sandbox"` | ⛔ STOP |

If the file contains multiple configurations, use the first one with `"environmentType": "Sandbox"` — the **target configuration** — and only that one. The configurations below it (a debug or attach configuration for the customer's QA, for instance) play no part. If none qualifies, stop.

**If the target configuration targets QA** (its `"environmentName"` or `"name"` contains `QA` in any casing): STOP. Do not pick the next configuration, do not ask, do not edit `launch.json`. Report:
> 🛑 **First sandbox configuration targets QA** — configuration `<name>` targets `<environmentName>`. Tests are never run against, and code is never published to, a QA environment. Put the configuration of your development sandbox at the top of `.vscode/launch.json` and re-run. QA configurations below it may stay.

**If OnPrem is detected** (a `"server"` / `"serverInstance"` configuration, or no `"environmentType"`): STOP. Report:
> ❌ **OnPrem environment detected** — this skill runs tests against BC SaaS sandboxes only.
> Add a launch configuration with `"environmentType": "Sandbox"` and an `"environmentName"` to `.vscode/launch.json`.

**If production is detected** (`"environmentType": "Production"`): STOP. Report:
> ❌ **Production environment detected** — Running tests on production is not allowed.
> Switch to a sandbox configuration (`"environmentType": "Sandbox"`) in `launch.json`.

**If no launch.json exists:** STOP. Report:
> ❌ **No launch.json found** — Configure `.vscode/launch.json` with a SaaS sandbox configuration before running tests.

**If `al` CLI is not installed:** STOP. Report:
> ❌ **`al` CLI tool not found** — Install with:
> `dotnet tool install --global microsoft.dynamics.businesscentral.development.tools --prerelease`

### Step 2: Identify Test Scope

Determine what to run based on user input:

| User Input | Action |
|---|---|
| Single codeunit ID (e.g., `50100`) | Run once with that ID |
| Single codeunit name | Resolve the numeric ID from the workspace, then run |
| Multiple codeunit IDs/names | Run `al runtests` once per codeunit ID; aggregate results |
| Specific test method | Use `--testmethods <methodName>` |
| `/iFacto.Pullrequest` Step 4 (the PR test gate) | Every test codeunit in the workspace (`Subtype = Test`), each run with all methods — do not ask. Any FAIL or ERROR is a hard stop for the PR |
| No input / "all" (outside the PR gate) | Ask with `AskUserQuestion` — running all codeunits is not supported in a single call. Offer the 3 test codeunits most likely meant (the ones touched by the current change, or the most recently modified in the workspace), each labelled with ID + name, and let "Other" take a codeunit you did not list |

If a codeunit name cannot be resolved to an ID in the workspace, warn the user and skip it — do not abort.

### Step 3: Build the Command

Construct the `al runtests` command from the validated **Sandbox** configuration in `launch.json`:

```bash
al runtests <codeunitId> \
  --project "<projectFolder>" \
  --environmentname "<environmentName>" \
  --environmenttype Sandbox \
  --tenant "<tenant>" \
  [--company "<companyName>"]
```

`--environmenttype` is always `Sandbox`. Never emit `--server`, `--serverinstance`, or `--authentication Windows` — reaching this step with OnPrem values means Step 1 was skipped.

**Optional:** Add `--testmethods <methodName>` to run a single test method.

For multiple codeunits, repeat the command for each codeunit ID and collect all outputs.

### Step 4: Execute and Collect Output

Run the command(s) in the terminal. The `al runtests` command runs synchronously — no polling required.

Parse the CLI output for per-method results. The output includes:
- Codeunit name and ID
- Individual test method names
- Result per method: PASS / FAIL / ERROR
- Error messages for failures

If authentication fails with a cached token, retry with `--nocache` to force re-authentication.

### Step 5: Report Results

Display results in this format:

```
## Test Results

### [Codeunit Name] (ID: XXXXX)
| Test Method | Result | Error |
|---|---|---|
| TestMethodA | ✅ PASS | — |
| TestMethodB | ❌ FAIL | [error message] |
| TestMethodC | ✅ PASS | — |

**Codeunit total: 2 passed, 1 failed**

---
## Summary
Total: X passed ✅ | Y failed ❌ | Z skipped ⏭ | X codeunits executed
Overall: ✅ ALL PASS / ❌ FAILURES DETECTED
```

For failures, include the full error message from the CLI output.

## Failure Handling

| Problem | Action |
|---|---|
| App not deployed | STOP — use `al-build-validation` skill to publish, then retry |
| `al` CLI not found | STOP — provide install command (see Prerequisites) |
| Authentication failure | Retry with `--nocache`; if still failing, ask user to re-authenticate manually |
| Codeunit not found on server | Warn — app may not be deployed or codeunit ID is wrong |
| First sandbox configuration targets QA | STOP — never run tests against or publish to QA, also when it is a Sandbox |
| Production environment detected | STOP — do not run tests against production |
| OnPrem environment detected | STOP — do not run tests against OnPrem; require a Sandbox configuration |
| No Sandbox configuration in launch.json | STOP — do not fall back to any other environment type |
| Multiple codeunits requested | Run sequentially, one command per codeunit; aggregate results |

## Constraints

- **SaaS sandbox only** — will not run against OnPrem, Production or a QA environment; `"environmentType": "Sandbox"` is required in `launch.json`
- **App must be pre-deployed** — this skill does not publish; use `al-build-validation` for that
- **One codeunit per command** — `al runtests` takes a single `<codeunitId>`; run multiple times for multiple codeunits
- **Requires `al` CLI prerelease** — `al runtests` is part of `microsoft.dynamics.businesscentral.development.tools` prerelease (`18.x` or later)

## Output Format

```
Test Run Status: ✅ ALL PASS / ❌ FAILURES DETECTED
Codeunit: <name> (ID: <id>)
Tests: X passed | Y failed | Z skipped
```
