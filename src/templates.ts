/**
 * Built-in goal templates, bundled with the package so `/goal template <name>`
 * works out of the box. Users can still add their own at `.opencode/goals/<name>.json`
 * (the server checks that directory first, then falls back to these).
 */

import type { GoalConstraints } from "./goal-state.js";

export interface GoalTemplate {
  description: string;
  condition: string;
  command?: string;
  constraints?: Partial<GoalConstraints>;
}

export const BUILTIN_TEMPLATES: Record<string, GoalTemplate> = {
  "fix-lint": {
    description: "Fix all lint errors in the project",
    condition: "the lint command exits with code 0",
    command: "npm run lint",
    constraints: { maxTurns: 10, maxTimeMinutes: 15, maxTokens: 50000 },
  },
  "fix-types": {
    description: "Make the TypeScript type-check pass",
    condition: "tsc reports no type errors",
    command: "npx tsc --noEmit",
    constraints: { maxTurns: 10, maxTimeMinutes: 15, maxTokens: 50000 },
  },
  "pass-tests": {
    description: "Make the test suite pass",
    condition: "the test command exits with code 0 with no failing tests",
    command: "npm test",
    constraints: { maxTurns: 15, maxTimeMinutes: 20 },
  },
};
