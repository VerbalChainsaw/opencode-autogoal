// Generates REVIEW-BUNDLE.md: every source/test/config file in one document,
// with a review prompt on top, so it can be handed to another model in one paste.
import { readFileSync, writeFileSync } from "node:fs";

const FILES = [
  "package.json",
  "tsconfig.build.json",
  "src/goal-state.ts",
  "src/command.ts",
  "src/templates.ts",
  "src/server.ts",
  "src/tui.tsx",
  "test/goal-state.test.mjs",
  "test/command.test.mjs",
  "README.md",
];

const lang = (f) =>
  f.endsWith(".ts") ? "ts" : f.endsWith(".tsx") ? "tsx" : f.endsWith(".mjs") ? "js" : f.endsWith(".json") ? "json" : f.endsWith(".md") ? "markdown" : "";

const preface = `# opencode-autogoal — full source for review

You are an adversarial code reviewer. This is a plugin for OpenCode (an AI coding
agent). It adds a /goal command and a background auto-loop that keeps the agent
working until a condition is met. Users can set goals conversationally (tools like
set_goal) or via a /goal command. Target runtime: OpenCode Desktop (Electron) +
terminal. The plugin is server-side, ships compiled JS, and its only dependency is
the OpenCode plugin API (@opencode-ai/plugin), which the host provides.

Please review hard for: correctness bugs, OpenCode plugin/SDK API misuse, security
(the state file at .opencode/.goal-state.json drives a shell command via exec on
every idle — is that a problem? path handling? injection?), robustness, thinness,
missing edge cases, and modern TypeScript standards. Be specific and skeptical.
Do not praise; find what is wrong or weak. Every file in the package is below.

---
`;

let out = preface;
for (const f of FILES) {
  let body;
  try {
    body = readFileSync(f, "utf-8");
  } catch {
    continue;
  }
  out += `\n\n## ${f}\n\n\`\`\`${lang(f)}\n${body}\n\`\`\`\n`;
}

writeFileSync("REVIEW-BUNDLE.md", out, "utf-8");
console.log(`Wrote REVIEW-BUNDLE.md (${out.length} chars, ${FILES.length} files)`);
