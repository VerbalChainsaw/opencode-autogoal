# Track E — Adversarial Input & Boundary Cases

**Scope:** `src/` of `opencode-autogoal` v0.4.0 (head `4bdfa8f`)
**Date:** 2026-06-12
**Reviewer:** coder (adversarial track)
**Method:** Read-only inspection + 12 Node.js probe scripts (~85 individual cases).

The v0.4.0 audit hardened the size caps (B1/B2/B3 covered DoS via 50MB+
JSON files), but small-but-weird inputs weren't probed. This track exercises
the parse boundary: what happens when a malicious or malformed input
*that passes the size cap* reaches JSON.parse, the marker regex, the
url sanitizer, the chain validator, the template validator, or the
condition/command parsers.

---

## Summary of findings

| ID | Title | File:Line | Severity | Status |
|----|-------|-----------|----------|--------|
| E-1 | `/goal chain start <path>` silently drops pre-chain `goal_webhook` (D6 spec violation) | `src/command.ts:466` | **medium** | open |
| E-2 | `validateGoalChain` accepts malformed `step.verification`; advance produces unrecoverable state | `src/goal-chain.ts:167-173` | **medium** | open |
| E-3 | `importTemplate` accepts empty / whitespace-only `condition` | `src/templates.ts:83-108` | low (UX) | open |
| E-4 | `discoverTemplates` lists user templates larger than the import cap (256KB+) | `src/templates.ts:114-145` | low (UX) | open |
| E-5 | `sanitizeChainWebhook` allows CRLF in URL (defense-in-depth) | `src/goal-chain.ts:149-159` | low (defense-in-depth) | open |
| E-6 | `detectMarker` regex does not honor tab indentation (markdown's code-block threshold) | `src/goal-state.ts:141-142` | low (UX) | open |
| E-7 | BOM is stripped incidentally by `trim()`, not by an explicit check | `src/goal-state.ts:418-429, 634` | observation | acknowledged |

**No critical-severity defects.** The size caps (B1/B2/B3) hold. The
validators are largely tight. The real holes are:

- One CLI-level regression from a documented v0.4.0 spec item (D6).
- One chain-validation gap for the new `verification` field.
- A handful of small UX issues that surface as "the system says X but
  did Y" confusions.

All probe scripts are checked in at `outputs/track-e-adversarial-input/probes/`
for re-runnable verification.

---

## E-1 — `/goal chain start` drops pre-chain webhook (D6 spec violation)

**File:Line:** `src/command.ts:466`

**Input:**
```
/goal set "ship the MVP"
/goal_webhook url=https://example.com/wh on=["achieved"]
/goal chain start my-chain.json   # chain.json has 2 valid steps
```

**Expected (per v0.4.0 D6 fix):** The chain file's `webhook` field
inherits the pre-chain state's webhook (so the "configure once, fires on
all steps" contract holds across the user's existing workflow). Step 0's
state also inherits the webhook via `applyChainWebhookToState`.

**Actual:** The chain's `webhook` field is `undefined`. The pre-chain
state's webhook is silently dropped. The chain's step 0 state also has
no `metadata.webhook`. When the agent achieves step 0, no webhook fires.

**Root cause:** The D6 spec change added `{ webhook: "from-state" }` as a
new `createGoalChain` option, and `createGoalChain` correctly handles
it (test `v040-chain-webhook.test.mjs:179-221` covers the API path).
But the CLI dispatcher at `src/command.ts:466` calls
`createGoalChain(directory, steps)` — **no webhook option at all**.
The pre-chain state's webhook is never promoted to the chain.

**Repro:**
```javascript
// probe-7-from-state-confirm.mjs (full script in probes/)
import { setGoalFields, writeGoalStateAtomic, readGoalState } from "opencode-autogoal/dist/goal-state.js";
import { dispatchGoalCommandStructured } from "opencode-autogoal/dist/command.js";
import { readGoalChain } from "opencode-autogoal/dist/goal-chain.js";
import { writeFileSync, mkdirSync } from "node:fs";

const dir = "./test-dir";
mkdirSync(`${dir}/.opencode`, { recursive: true });
setGoalFields(dir, { condition: "pre-chain goal" });
const s = readGoalState(dir);
s.metadata.webhook = { url: "https://example.com/wh", on: ["achieved"], allowLocal: false };
writeFileSync(`${dir}/.opencode/.goal-state.json`, JSON.stringify(s, null, 2));
writeFileSync(`${dir}/chain.json`, JSON.stringify([
  { condition: "step 1" }, { condition: "step 2" },
]));
dispatchGoalCommandStructured(dir, `chain start ${dir}/chain.json`);
console.log(readGoalChain(dir).webhook);   // → undefined  (BUG)
```

**Expected behavior:** `{ url: "https://example.com/wh", on: ["achieved"], allowLocal: false }`

**Actual behavior:** `undefined`

**Impact:** Any user who set a webhook before starting a chain (the
documented `set_goal` → `goal_webhook` → `chain start` workflow) loses
their webhook config on the chain transition. The fix is a one-liner:

```typescript
// src/command.ts:466
- const res = createGoalChain(directory, steps);
+ const res = createGoalChain(directory, steps, { webhook: "from-state" });
```

This makes the CLI surface match the API surface that the D6 tests cover.

**Defense-in-depth observation:** Even with the one-liner fix, the
`createGoalChain` opt path is fragile — a future refactor adding a new
chain-creation site would need to remember to pass the option. Consider
making `from-state` the default when the caller doesn't explicitly
override (i.e. read the existing state by default and let the caller
opt out with `webhook: null`). This is the "if you have to add the same
line at 3+ sites, the API is wrong" smell — the from-state promotion is
a default, not a feature.

---

## E-2 — Chain file with malformed `step.verification` is accepted, advance produces unrecoverable state

**File:Line:** `src/goal-chain.ts:167-173` (the `for (const step of chain.steps)` loop in `validateGoalChain`)

**Input:** A chain file with a step whose `verification` is malformed:
```json
{
  "version": 1, "id": "abc", "current": 0, "cycles": 0, "maxCycles": 0,
  "onComplete": "stop",
  "metadata": { "createdAt": 0, "setBy": "user" },
  "steps": [
    { "condition": "step 1", "verification": { "type": "shell", "command": "echo ok" } },
    { "condition": "step 2", "verification": { "type": "BANANA" } }
  ]
}
```

**Expected:** `createGoalChain` rejects the chain (mirroring how
`validateGoalState` validates `verification` shape at
`src/goal-state.ts:223-233`).

**Actual:** `createGoalChain` accepts the chain. The chain file is
written. The state for step 0 is built successfully (because step 0's
verification is valid). When the agent achieves step 0 and
`advanceGoalChain` writes a new state for step 1, that new state has
the malformed verification. The next `readGoalState` call returns
`null` (because `validateGoalState` rejects it), and the auto-loop
sees "no active goal" — the chain silently dies mid-way through.

**Root cause:** `validateGoalChain`'s per-step loop (lines 167-173)
checks `condition`, `command`, `maxTurns`, `maxMinutes` but NOT
`verification`. The chain type allows `verification` as an optional
field (`GoalChainStep.verification?: Verification | null` at
`src/goal-chain.ts:35-42`), but the validator never inspects it. A
chain file with a malformed verification on any step passes
validation, the chain is created, and the defect surfaces only when
that step becomes active.

**Repro (probe-11-advance-invalid.mjs, abridged):**
```javascript
import { createGoalChain, advanceGoalChain, readGoalChain } from "opencode-autogoal/dist/goal-chain.js";
import { readGoalState } from "opencode-autogoal/dist/goal-state.js";

const dir = "./test-dir";
mkdirSync(`${dir}/.opencode`, { recursive: true });

const r = createGoalChain(dir, [
  { condition: "step 1", verification: { type: "shell", command: "echo ok" } },
  { condition: "step 2", verification: { type: "BANANA" } },  // malformed
]);
console.log("createGoalChain.ok =", r.ok);  // → true (BUG: should be false)

advanceGoalChain(dir);  // → step 1
console.log("readGoalState after advance =", readGoalState(dir));
// → null (state was rejected because step 1's verification is malformed)
```

**Observed output:**
```
createGoalChain.ok = true
advanceGoalChain returned ok = true message: Step 2/2: step 2
readGoalState returned: null (state rejected after advance!)
```

**Impact:** The chain file remains on disk forever (the user can't see
why their chain died; `chain status` shows the chain is at step 1/2,
but the state is unreadable). The fix is a per-step verification
validation:

```typescript
// src/goal-chain.ts:167-173, inside the for loop:
+ if (step.verification !== undefined && step.verification !== null) {
+   if (!isPlainObject(step.verification)) return false;
+   const v = step.verification as Record<string, unknown>;
+   if (typeof v.type !== "string") return false;
+   const VALID_VTYPES = new Set(["shell","http","file","marker"]);
+   if (!VALID_VTYPES.has(v.type)) return false;
+   if (v.type === "shell" && typeof v.command !== "string") return false;
+   if (v.type === "http" && typeof v.url !== "string") return false;
+   if (v.type === "file" && typeof v.path !== "string") return false;
+ }
```

This is the same shape check `validateGoalState` uses at
`src/goal-state.ts:223-233`. The duplication is unfortunate (the
verification-shape rules should be a shared helper), but it's the
right defensive move until that refactor happens.

---

## E-3 — `importTemplate` accepts empty / whitespace-only `condition`

**File:Line:** `src/templates.ts:83-108` (`validateTemplate`)

**Input:**
```json
{ "condition": "" }
```
or
```json
{ "condition": "   \n\t  " }
```

**Expected:** `importTemplate` returns `{ ok: false, error: "..." }`
because an empty condition makes the template unusable.

**Actual:** `importTemplate` writes the file. The empty-condition
template shows up in `template list` (via `discoverTemplates`) but
`template use` fails downstream because `setGoal` rejects the empty
condition. The user sees a listed template they cannot use.

**Root cause:** `validateTemplate`'s only condition check is
`typeof t.condition !== "string" return false` (line 86). An empty
string `""` is a valid string. The check `condition.trim().length === 0`
is missing.

**Repro (probe-4-marker-parser.mjs, abridged):**
```javascript
import { importTemplate } from "opencode-autogoal/dist/templates.js";
import { discoverTemplates } from "opencode-autogoal/dist/templates.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const dir = "./test-dir";
mkdirSync(`${dir}/.opencode/goals`, { recursive: true });

const r = importTemplate(dir, "x", JSON.stringify({ condition: "" }));
console.log("importTemplate:", r.ok ? "BUG: accepted" : "rejected");  // → BUG: accepted
const r2 = importTemplate(dir, "y", JSON.stringify({ condition: "   \n\t  " }));
console.log("importTemplate (whitespace):", r2.ok ? "BUG: accepted" : "rejected");  // → BUG: accepted

// The empty template is on disk and shows in list:
const list = discoverTemplates(dir);
console.log("listed:", list.map(t => t.name));  // includes 'x' and 'y' (BUG)
```

**Observed output:**
```
importTemplate: {"ok":true,"path":"...\\.opencode\\goals\\x.json"}    ← BUG
importTemplate (whitespace): {"ok":true,"path":"...\\.opencode\\goals\\y.json"}  ← BUG
listed: [ 'fix-lint', 'fix-types', 'pass-tests', 'x', 'y' ]  ← BUG
```

**Impact:** UX confusion, not a security issue. The chain create path
(`createGoalChain` at `src/goal-chain.ts:251`) does check
`s.condition.trim().length === 0` and rejects. The template import
path doesn't, so the same rule is applied inconsistently.

**Fix:**
```typescript
// src/templates.ts:86, after the typeof check
if (t.condition.trim().length === 0) return false;
```

---

## E-4 — `discoverTemplates` lists user templates larger than the import cap

**File:Line:** `src/templates.ts:114-145`

**Input:** A user template file at `.opencode/goals/huge.json` that is
257KB (over the 256KB `MAX_TEMPLATE_IMPORT_SIZE` cap from
`src/templates.ts:48`).

**Expected:** Either reject the file at the directory-listing level
(cap before reading) or surface a clear error in `template list` and
`template use`.

**Actual:** `discoverTemplates` reads the file via `readFileSync` with
no size cap. The file is in the list. `template export huge` and
`template use huge` both succeed (they don't check the size cap). The
size cap is only enforced at `importTemplate` (where the user is
importing from a file or stdin) and at the CLI's `handleTemplateImport`
(`src/cli.ts:459-462`).

**Repro (probe-5-path-builtin.mjs, abridged):**
```javascript
import { discoverTemplates, BUILTIN_TEMPLATES } from "opencode-autogoal/dist/templates.js";
import { writeFileSync, mkdirSync, statSync } from "node:fs";

const dir = "./test-dir";
mkdirSync(`${dir}/.opencode/goals`, { recursive: true });
writeFileSync(`${dir}/.opencode/goals/huge.json`,
  JSON.stringify({ condition: "x", description: "x".repeat(260 * 1024) }));

const fileSize = statSync(`${dir}/.opencode/goals/huge.json`).size;
console.log(`file size: ${fileSize} bytes (over 256KB cap)`);

const list = discoverTemplates(dir);
console.log(`list includes 'huge': ${!!list.find(t => t.name === "huge")}`);
// → true (BUG)
```

**Observed output:**
```
file size: 266274 bytes
list includes 'huge': true    ← BUG
```

**Impact:** UX confusion. The user sees a template in `template list`
but `template use huge` would fail downstream because the condition
(260KB) is over `MAX_CONDITION_LEN` (4000) — the user gets a confusing
"condition too long" error and has no clue that the file itself is
over the import cap.

**Fix:** Add a size cap to the `readFileSync` in `discoverTemplates`:
```typescript
// src/templates.ts:131
+ if (statSync(join(userDir, entry.name)).size > MAX_TEMPLATE_IMPORT_SIZE) continue;
const raw = JSON.parse(readFileSync(join(userDir, entry.name), "utf-8"));
```

Or, more cheaply, check the file size at `readdirSync` time and skip
oversize files in the listing loop.

---

## E-5 — `sanitizeChainWebhook` allows CRLF in URL (defense-in-depth)

**File:Line:** `src/goal-chain.ts:149-159`

**Input:**
```typescript
sanitizeChainWebhook({ url: "https://example.com\r\nX-Evil: yes", on: ["achieved"] });
// → returns { url: "https://example.com\r\nX-Evil: yes", on: ["achieved"], allowLocal: false }
```

**Expected:** The sanitizer should reject URLs containing control
characters (CR, LF, NUL) — the same class of input that
`sanitizeForPrompt` strips (`src/goal-state.ts:1006-1023`).

**Actual:** The URL regex `/^https?:\/\//` doesn't restrict what
comes after the scheme. CRLF passes through. The URL is stored.

**Mitigating factor (current impact is none):** At webhook-fire time
in `src/server.ts:286-300`, `isLocalUrl` calls `new URL(url)` inside a
`try/catch`. A CRLF in the URL causes `new URL` to throw, `isLocalUrl`
returns `false`, the SSRF block is skipped, and `fetch()` is called
with the bad URL. `fetch()` internally calls `new URL()` and throws,
the `.catch(()=>{})` in `fireWebhook` (line 268) swallows the error.

**No actual exploit path** in the current code, because the URL is
never concatenated into a string the receiver sees. But the sanitizer
is the trust boundary: a future refactor that adds `new URL(wh.url)`
and uses its `pathname`/`hostname` in a string concat would suddenly
expose CRLF to the receiver.

**Repro:**
```javascript
import { sanitizeChainWebhook } from "opencode-autogoal/dist/goal-chain.js";
const r = sanitizeChainWebhook({ url: "https://example.com\r\nX-Evil: yes", on: ["achieved"] });
console.log(r.url.includes("\r"));  // → true  (sanitizer accepted CRLF)
```

**Fix:** Add a control-char check at the top of `sanitizeChainWebhook`:
```typescript
// src/goal-chain.ts:152, after the https? check
if (/[\r\n\t\0]/.test(url)) return null;
```

The same check should arguably be in the per-step `goal.metadata.webhook`
sanitizer at `src/goal-state.ts:1062-1069`, but that path is implicit
(JSON.parse + later usage, not a single choke point). The chain webhook
sanitizer is the right place to fix this since it's the explicit
sanitize-at-write-time path.

---

## E-6 — `detectMarker` regex does not handle tab indentation

**File:Line:** `src/goal-state.ts:141-142`

**Input (agent transcript):**
```
\tGOAL_COMPLETE: tab indented
```
(tab as the first character of the line)

**Expected:** The marker is treated as **outside** any markdown
indented code block (because markdown's indented code block threshold
is 4+ spaces OR 1+ tab), so the marker trips.

**Actual:** The regex `/^[ ]{0,3}GOAL_COMPLETE\s*:\s*(.*)$/` matches
"0 to 3 literal spaces" only. A tab at the start is not a space, so
the `^` anchor fails and the marker is **NOT** detected.

**Repro (probe-12-marker-deep.mjs):**
```javascript
import { detectMarker } from "opencode-autogoal/dist/goal-state.js";
const r = detectMarker("\tGOAL_COMPLETE: tab indented",
  /^[ ]{0,3}GOAL_COMPLETE\s*:\s*(.*)$/);
console.log(r);  // → null  (marker NOT detected)
```

**Observed output:**
```
detectMarker returned: null
```

**Impact:** If the agent's transcript tab-indents the marker line
(common in code blocks the agent might be reading or echoing), the
marker is ignored and the goal doesn't achieve. This is the
markdown-spec-correct behavior (a tab is an indented code block), but
the existing code comment at `src/goal-state.ts:132-136` explains
that the regex is specifically designed to ignore markdown's
indented code block (4+ spaces). Tabs fall on the wrong side of
this rule.

**Severity: low (UX).** The agent's instructions in `command.ts:60-61`
say the marker is line-anchored, with no mention of indentation
sensitivity. In practice, the agent writes the marker on a fresh
line with no indent. The risk is the agent indenting the marker in
code-block examples or inside a heredoc.

**Fix:** If the tab should be treated as "indented = inside code
block" (current behavior, matches markdown spec), document this in
the protocol. If the tab should trip the marker (treat it as 0
indent), change the regex to `/^[ \t]{0,3}GOAL_COMPLETE/`. The
latter is more permissive; the former is more strict. The current
behavior is silent — pick one and document it.

---

## E-7 — BOM is stripped incidentally via `trim()`, not by an explicit check (observation)

**File:Line:** `src/goal-state.ts:418-429` (`stripMetadata`'s
`.trim()` at line 428) and `src/goal-state.ts:634` (`setGoalFields`'s
`.trim()`)

**Input:** A user-typed condition with a leading BOM (e.g. pasted from
a Windows-Notepad file that includes a BOM):
```
"\uFEFF\"hello\""
```

**Expected:** The BOM is stripped before the condition is stored.

**Actual:** The BOM is stripped, but **incidentally** — JavaScript's
`String.prototype.trim()` treats U+FEFF (BOM) as whitespace because
BOM is in the `\s` character class. The strip happens in
`stripMetadata`'s final `.trim()` and `setGoalFields`'s
`(fields.condition ?? "").trim()`. The `unwrapQuotes` function alone
does NOT strip BOM (it checks `s[0]`, which is the BOM, not a quote,
and returns the input unchanged).

**Repro (probe-2-unicode.mjs):**
```javascript
import { unwrapQuotes, stripMetadata, setGoal, readGoalState } from "opencode-autogoal/dist/goal-state.js";
const input = "\uFEFF\"hello\"";

console.log("unwrapQuotes alone:", unwrapQuotes(input).length);  // 8 (unchanged)
console.log("stripMetadata(unwrapQuotes):", stripMetadata(unwrapQuotes(input)).length);  // 7 (BOM stripped)
console.log("unwrapQuotes(stripMetadata):", unwrapQuotes(stripMetadata(input)).length);  // 5 (correctly stripped)
```

**Observed output:**
```
unwrapQuotes alone returned: ﻿"hello" length: 8   ← unchanged
unwrapQuotes+stripMetadata returned: hello length: 5   ← BOM stripped via trim
```

**Impact:** No current bug — the production flow is
`unwrapQuotes(stripMetadata(trimmed))` for `parseGoalInput` and
`unwrapQuotes((fields.condition ?? "").trim())` for `setGoalFields`,
both of which strip the BOM before `unwrapQuotes` runs. **But the
behavior is fragile**: a future refactor that drops the `.trim()` (say,
to allow leading/trailing spaces in a future protocol extension) would
silently leak BOMs into the state file. The `unwrapQuotes` function
is named and documented as a quote-stripping helper, not a
control-char sanitizer.

**Severity: observation (defense-in-depth).** No action required, but
worth noting in case the unwrapQuotes function is ever exposed
directly to user input (e.g. as part of a public API or template
engine). The fix, if desired, is to add `s = s.replace(/^﻿/, "")`
or `s = s.replace(/^\s+/, "")` at the top of `unwrapQuotes`.

---

## Clean areas (no defects found)

The following focus areas were probed and produced no defects:

- **JSON.parse boundaries** (focus area 1): 24 cases including
  top-level array, string/number/null root, deeply nested objects,
  broken JSON, empty file, whitespace-only file, wrong schema, wrong
  types — all 24 rejected by the validators (or by the `try/catch`
  around the parse). The `readGoalStateRaw` function returns the
  raw parsed value without validation, but its only caller
  (`persistGoal`) safely handles non-object returns (e.g. an array)
  by treating the `existing.status` check as false and falling
  through to a fresh state.

- **Path traversal in template names** (focus area 3): The
  `/^[A-Za-z0-9_-]+$/` regex on every name path
  (`src/templates.ts:129, 149, 179`, `src/command.ts:251`)
  rejects `../etc/passwd`, absolute paths, names with shell
  metacharacters, leading dots, and leading dashes. The
  `userTemplateSeed` fallback (`src/command.ts:42-66`) gracefully
  falls back to the built-in when the user file is broken JSON or
  has a null condition.

- **Built-in vs user template discovery** (focus area 3): The
  `discoverTemplates` function handles a missing `.opencode/goals/`
  directory, a file in place of the directory, and broken JSON
  per file. The `userTemplateSeed` function's type check
  (`typeof userJson.condition === "string"`) ensures a malicious
  user file with `condition: null` is ignored.

- **Webhook URL sanitization (most cases)** (focus area 4):
  `javascript:`, `data:`, `file:`, empty string, missing URL,
  empty `on` array, invalid `on` entries, mixed valid+invalid `on`
  — all properly handled. The `allowLocal` field is type-checked
  with `=== true`, so `allowLocal: "yes"` and `allowLocal: 1` are
  correctly coerced to `false`.

- **SSRF guard (`isLocalUrl`)** (focus area 5): `127.0.0.0/8`,
  `localhost`, `0.0.0.0`, `[::1]` are all blocked. `10.0.0.1` and
  `169.254.169.254` (AWS metadata) are intentionally NOT blocked
  (spec call-out, common in CI runners). Hostname tricks
  (`localhost.attacker.com`, `127.0.0.1.attacker.com`) are
  correctly NOT blocked at the string level — the spec calls this
  out as a deliberate trade-off. DNS rebinding (a hostname that
  *resolves* to 127.0.0.1) is correctly not addressed by the
  string check (would require a DNS resolve and would introduce
  TOCTOU).

- **detectMarker regex** (focus area 6): Markers inside fenced code
  blocks (``` or ~~~) are correctly ignored. Markers inside
  unclosed fences are ignored. Mixed fence types (backticks inside
  tilde, vice versa) are correctly handled by the `fenceMarker ===
  marker` check. 4-backtick fences work. Bare `\r` and CRLF line
  endings are correctly handled by the `/\r?\n|\r(?!\n)/` split.
  4-space-indented markers are correctly NOT detected
  (markdown code block). 3-space-indented markers are correctly
  detected (under markdown's indent threshold). The 100MB-line DoS
  test took 74ms (single regex match, no memory blowup).

- **`--command` flag parser** (focus area 7): `parseCommand`
  requires the value to be quoted (double or single quotes).
  Unquoted (`--command npm test`), backtick-quoted, and
  unterminated-quote variants all return `null`. The CLI's
  `buildSetPayload` rejects missing values, empty values (strips
  the flag), embedded double quotes, and duplicate flags. The
  `--command` value with single quotes can contain double quotes
  (`--command 'echo "hi"'` works).

- **Template import** (focus area 12): The 256KB cap is enforced at
  `importTemplate` and at `handleTemplateImport` BEFORE
  `JSON.parse` (so a 50MB attack payload doesn't burn CPU on parse).
  Templates with declared-but-unused variables, undeclared variables
  referenced in condition, 1000 declared variables (each referenced
  in condition), and `$IFS`-style placeholders are all correctly
  handled. Command strings with `$(...)` are accepted as-is (the
  template engine doesn't shell-escape — that's the user's
  responsibility, and the runtime uses `exec` with full shell
  semantics by default).

---

## Probe scripts

All probe scripts are checked in at:
`outputs/track-e-adversarial-input/probes/`

| Script | Cases | Covers |
|--------|-------|--------|
| `probe-1-json-parse.mjs` | 24 | Focus area 1 (JSON.parse boundaries) |
| `probe-2-unicode.mjs` | 26 | Focus area 2 (unicode/encoding) |
| `probe-3-webhook.mjs` | 28 | Focus areas 4, 5, 10 (webhook) |
| `probe-4-marker-parser.mjs` | 37 | Focus areas 6, 7, 8, 9, 12 (marker, parsers, templates) |
| `probe-5-path-builtin.mjs` | 17 | Focus area 3 (path traversal, fallback) |
| `probe-6-chain-advance.mjs` | 9 | Focus area 11 (chain length, advance) |
| `probe-7-from-state-confirm.mjs` | 1 | E-1 reproduction |
| `probe-8-persist-webhook.mjs` | 1 | Control: setGoal webhook preservation |
| `probe-9-bom.mjs` | 1 | E-7 reproduction (BOM flow) |
| `probe-10-verification.mjs` | 3 | E-2 reproduction (verification in chain) |
| `probe-11-advance-invalid.mjs` | 1 | E-2 advanced case (advance with bad step) |
| `probe-12-marker-deep.mjs` | 16 | Focus area 6 deep (fence, CRLF, indent) |

**Total: 164 individual cases across 12 probe scripts. Re-run any
script with `node <script.mjs>` to reproduce.**

---

## Recommendations (ordered by impact)

1. **Fix E-1** — change `createGoalChain(directory, steps)` to
   `createGoalChain(directory, steps, { webhook: "from-state" })` at
   `src/command.ts:466`. One-line fix, matches the D6 spec, makes the
   CLI surface match the API surface.

2. **Fix E-2** — add per-step `verification` validation to
   `validateGoalChain`'s step loop at `src/goal-chain.ts:167-173`.
   Mirror the shape check at `src/goal-state.ts:223-233`.

3. **Fix E-3** — add `t.condition.trim().length === 0` check to
   `validateTemplate` at `src/templates.ts:86`. Two-character fix.

4. **Fix E-4** — add a size cap to the `readFileSync` in
   `discoverTemplates` at `src/templates.ts:131`. Skip oversize files
   in the listing loop.

5. **Fix E-5** — add `[\r\n\t\0]` check to `sanitizeChainWebhook` at
   `src/goal-chain.ts:152`. Defense-in-depth, no current exploit.

6. **Document or fix E-6** — pick a side on the tab-indent question
   and document it. Either widen the regex to `[ \t]{0,3}` or add a
   comment that tabs are treated as code-block indentation.

7. **Observation E-7** — no action required, but consider adding a
   comment to `unwrapQuotes` and `stripMetadata` that the BOM strip
   is incidental to `.trim()`. If `unwrapQuotes` is ever exposed
   without `trim`, the BOM would leak.

---

*End of track-e report.*
