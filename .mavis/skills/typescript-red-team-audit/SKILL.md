# Skill: TypeScript Red-Team Audit

## Purpose

Prevent thrashing during adversarial TypeScript code audits. Replace open-ended "find bugs" loops with a structured scan-then-trace approach that produces findings or terminates cleanly.

## Trigger Conditions

Use this skill when:

- A red-team / adversarial audit is requested on TypeScript code.
- The agent starts re-reading the same files multiple times without new findings.
- More than 3 analysis cycles produce zero concrete bugs.
- The agent says "let me check one more thing" repeatedly.
- A green build is suspected of hiding runtime defects via unsafe casts or shallow tests.

## Failure Pattern

Agents default to this anti-pattern:

```
read file → think about bugs → read another file → think more → 
read the same file again → "one more check" → 
"let me look at a different area" → repeat
```

This is thrashing. It wastes turns and produces no findings.

## Correct Strategy

Three passes. Terminate after Pass 3 with an honest verdict.

### Pass 1 — Scan (2 turns max)

Run these scans exactly once:

```bash
# Unsafe casts
rg -n ' as any| as unknown as |@ts-ignore|@ts-expect-error' src/ -g '*.ts'

# Dead patterns
rg -n 'let \w+ = .*\n.*\1\+\+' src/ -g '*.ts'

# Test dishonesty  
rg -n 'it\.skip|describe\.skip|\.only\(|TODO|FIXME' test/ -g '*.mjs'

# Missing coverage (zero-test functions)
rg -n '^export function' src/ -g '*.ts' > /tmp/exports.txt
rg -n '^import' test/ -g '*.mjs' > /tmp/imports.txt
# Compare: any exports not imported by any test?
```

### Pass 2 — Trace (3 turns max)

Pick the 3 highest-risk areas. For each:
1. Read the function once.
2. Trace ONE execution path end-to-end (not all paths).
3. If you find a bug, fix it and validate.
4. If no bug, move to the next area.

High-risk areas (in order):
1. File I/O with user-controlled paths
2. Shell/command execution paths
3. Permission/auth boundaries
4. Race conditions / lock mechanisms
5. Serialization/deserialization boundaries

### Pass 3 — Verdict

State honestly:
- Bugs found + fixed
- Areas checked + confirmed clean
- Remaining risk (if any)

Do NOT say "let me check one more thing" after Pass 3.

## Forbidden Strategies

- Re-reading the same source file more than once per pass.
- Starting a fourth analysis cycle without concrete findings.
- "What about..." exploration without a specific hypothesis.
- Congratulating the codebase before the audit is complete.
- Accepting "build passes" as proof of correctness.

## Implementation Pattern

```
PASS 1: SCAN (rg commands → list findings)
PASS 2: TRACE (read → trace single path → fix or move on) 
PASS 3: VERDICT (bugs found, areas clean, risk remaining)
STOP
```

## Validation

After each fix:
```bash
npx tsc -p tsconfig.build.json   # build must pass
node --test "test/*.test.mjs"    # all tests must pass
```

## Stop Conditions

**Success**: All 3 passes complete with either concrete fixes or a clean verdict.

**Escalate only if**: 
- A fix breaks existing tests and the breakage is not understood within 2 attempts.
- A runtime failure is observed that cannot be reproduced in unit tests.
- A true architecture-level flaw is discovered (not a one-line fix).

## Notes for Future Agents

Do not rediscover this.

The answer is not "read the file again harder."

The answer is:

```
scan → trace → fix → validate → verdict → stop
```

A green build with clean scans and honest trace passes IS the answer. Not every codebase has bugs.
