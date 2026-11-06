---
name: iFacto.al-security-review
description: 'Review AL code for BC-specific security risks (SecretText, IsolatedStorage, permissions, DataClassification, HttpClient, injection, telemetry, startup hooks). Has three modes — design (proactive threat model), code (inline guidance while writing), review (pass/fail audit of finished code). Use from iFacto.SolutionDesigner, iFacto.ALCoder, and iFacto.CodeReviewer.'
---

# AL Security Review

## When to Use

In `design` and `code` mode: invoke this skill whenever the work touches a security-sensitive AL primitive — credentials, permissions, web services, PII, telemetry — or whenever a security-focused review is requested.

In `review` mode the skill is **unconditional**: `iFacto.CodeReviewer` runs it on every review, whatever the diff contains. The trigger list below is not a gate for review mode — do not scan the diff for these constructs to decide whether the pass is needed, and never replace the pass with such a scan. A diff that touches none of them still gets the pass; its report then says so per category.

Trigger constructs include: `SecretText`, `IsolatedStorage`, `HttpClient`, `permissionset`, `entitlement`, `InherentPermissions`, `InherentEntitlements`, `DataClassification`, `SetFilter` with user input, `Session.LogMessage`, `FeatureTelemetry`, `OnCompanyOpen`, install/upgrade codeunits, API pages, SOAP/OData exposure.

## Standards Source

All three modes evaluate against the **security knowledge in the installed BCQuality
knowledge base** (locate it per the `iFacto.company-guidelines` skill, Step 1):

- `custom/knowledge/security/` — iFacto-specific security rules (this domain is still being
  populated — migration "fase 2"; enumerate whatever exists, never assume it's empty or full)
- `microsoft/knowledge/security/` and `microsoft/knowledge/privacy/` — the BC platform
  security rules (SecretText, IsolatedStorage scopes, inherent permissions,
  DataClassification, HttpClient, injection, telemetry hygiene, ...)

The findings are organized under the **seven iFacto security categories** (this framework is
owned by this skill): (1) secrets & credentials, (2) permissions & entitlements, (3) data
classification, (4) external communication, (5) injection & filter safety, (6) telemetry &
logging hygiene, (7) run-as elevation & startup hooks.

## Modes

Pick the mode that matches the calling context. The mechanics are similar — what differs is *when* you run, what you consult, and how you format the output.

### Mode: `design` (used by iFacto.SolutionDesigner)

**Goal:** identify security concerns BEFORE code exists, and codify them as constraints in the instruction document.

1. Read the feature description / JIRA / draft design
2. For each of the 7 security categories, decide: applicable or not?
3. For each applicable category, read the matching BCQuality security/privacy articles
   (custom layer first, then microsoft layer) IN FULL, including their `.good.al`/`.bad.al`
   samples, and derive the design constraints that must appear in the instruction document
   so the implementation will pass review
4. (Optional) assess higher-level architectural impact yourself (auth model, trust
   boundaries, data flow)
5. Output a **"Security Considerations" section** ready to paste into `App/Docs/Instructions/<KEY>.design.md`

**Output format (design mode):**
```markdown
## Security Considerations

### Applicable categories
- [x] 1. Secrets & credentials — feature stores API token
- [ ] 2. Permissions & entitlements — N/A (no new objects)
- [x] 3. Data classification — new fields capture customer email
- [x] 4. External communication — calls vendor REST API
- [ ] 5. Injection & filter safety — N/A
- [x] 6. Telemetry & logging — feature emits import telemetry
- [ ] 7. Run-as elevation & startup hooks — N/A

### Design constraints
1. API token MUST be `SecretText` stored via `IsolatedStorage` with `DataScope::Module` (microsoft/knowledge/security/secrettext-for-credentials.md)
2. New `Loyalty Email` field MUST use `DataClassification = EndUserIdentifiableInformation` (microsoft/knowledge/privacy)
3. All HTTP calls MUST use HTTPS; no certificate validation bypass (microsoft/knowledge/security/validate-user-configurable-urls.md)
4. Telemetry MUST exclude email/token; use business keys only (microsoft/knowledge/security/getlasterrortext-storage-is-privacy-not-security.md)

### Open questions
- Which scope for the token: Module (single tenant config) or Company (per-company)?
```

### Mode: `code` (used by iFacto.ALCoder)

**Goal:** make sure the right AL primitives are used WHILE the code is being written — not after.

1. Identify which of the 7 categories the current task touches (look at the design doc's Security Considerations section if present; otherwise infer from the task)
2. For each applicable category, read the matching BCQuality security/privacy articles (custom layer first, then microsoft layer) and their `.good.al` samples
3. Extract the concrete code patterns (e.g., the `SecretText` + `IsolatedStorage.SetEncrypted` pattern, the `DataClassification` value to pick, the `Permissions` entry to add)
4. Apply patterns as you write — the `.good.al` sample is the authoritative expression, the `.bad.al` sample is what reviewers will flag
5. After implementation, run `iFacto.al-build-validation` (diagnostics-only) — security-relevant rules in CodeCop / AppSourceCop / PerTenantExtensionCop become evidence

**Output format (code mode):** inline guidance as you implement — no standalone report. State which patterns you applied:
```
🔒 Applied iFacto security patterns:
- Category 1 (secrets): API key stored via IsolatedStorage.SetEncrypted, DataScope::Module
- Category 3 (data classification): "Loyalty Email" = EndUserIdentifiableInformation
- Category 4 (HTTP): HTTPS only, SecretText for Authorization header
```

### Mode: `review` (used by iFacto.CodeReviewer)

**Goal:** validate finished code against iFacto security standards. Produce a pass/fail report. Critical findings block merge.

This mode always runs all five steps below. It is never skipped because the rulebook or the BCQuality technical pass "already covered" security, and never shortened to a grep of the diff for `SecretText`, `HttpClient`, `IsolatedStorage` or `permissionset`: that is not a security review and must not be reported as one.

1. Determine review scope (changed files on current branch, or user-supplied file list)
2. Follow `iFacto.al-build-validation` skill in diagnostics-only mode to collect CodeCop / AppSourceCop / PerTenantExtensionCop output (some security issues are flagged by rulesets)
3. Invoke the **`al-code-review`** skill from the installed BCQuality plugin (Claude Code: `bcquality:al-code-review`) with the goal `"security review of the changed AL code"` — its dispatch runs the `al-security-review` and `al-privacy-review` leaf skills, which source security knowledge across ALL enabled layers (microsoft, community, and iFacto's custom rules)
4. Map each finding to one of the 7 iFacto categories via its `references[]` knowledge-file path, and categorize as Critical / High / Advisory with line references and exact corrections
5. Consolidate into the report below

**Output format (review mode):**
```markdown
## 🔒 AL Security Review

### Files reviewed
- {list}

### Per-category verdict (BCQuality security knowledge)
- ✅/❌ 1. Secrets & credentials: {detail with line refs + knowledge-file reference}
- ✅/❌ 2. Permissions & entitlements: {detail}
- ✅/❌ 3. Data classification: {detail}
- ✅/❌ 4. External communication: {detail}
- ✅/❌ 5. Injection & filter safety: {detail}
- ✅/❌ 6. Telemetry & logging hygiene: {detail}
- ✅/❌ 7. Run-as elevation & startup hooks: {detail}

### Compiler / ruleset findings
- CodeCop / AppSourceCop / PerTenantExtensionCop security-relevant warnings: {count + list}

### Agent findings (self-review pass, outside the knowledge base)
- {al-code-review findings tagged `from-sub-skill: "agent"`, plus anything you spotted yourself}

### 🚨 Critical (block merge)
- {all Critical findings}

### ⚠️ High (fix before release)
- {all High findings}

### 💡 Advisory
- {all Advisory findings}

### Verdict
Security: ✅ APPROVED / ❌ CHANGES REQUIRED
```

## Important

- **This skill is NOT a replacement for the `iFacto.company-guidelines` skill** — it runs alongside it, focused on security
- **In `review` mode, Critical findings are blocking** — same severity as company guideline violations
- **In `design` mode, output is markdown to insert into the instruction doc** — not a standalone deliverable
- **In `code` mode, output is inline guidance** — the skill influences the code being written, no separate report
- **Always cite the knowledge file** — never invent security rules ad hoc; cite the BCQuality article path and the category number
- **Hand off if scope is wrong** — if a "security review" actually needs a full code review, defer to the agent's full `iFacto.code-review` + `al-code-review` pass and only contribute the security categories
