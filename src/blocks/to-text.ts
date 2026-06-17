/**
 * src/blocks/to-text.ts — block-to-text fallback rendering per spec §9.
 *
 * `blockToText()` converts any RenderBlock to a plain-text representation.
 * `blockToTextForLLM()` wraps the output in `<tool-output>` markers for
 * LLM context injection.
 *
 * Every path is try/catch-guarded — the text fallback never fails.
 *
 * Zero deps beyond ./types.js.
 */

import type { RenderBlock } from "./types.js";

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Convert a single block to plain text. Every block type has a deterministic
 * text representation. Unknown types return a safe fallback.
 */
export function blockToText(block: RenderBlock): string {
  try {
    switch (block.type) {
      case "text": {
        // Strip markdown bold/italic so the plain-text fallback is clean.
        // The content field carries markdown for the Desktop BlockRenderer;
        // the text fallback strips formatting for readable plain output.
        let text = block.content ?? "";
        text = text.replace(/\*\*(.+?)\*\*/g, "$1");
        text = text.replace(/\*(.+?)\*/g, "$1");
        text = text.replace(/`(.+?)`/g, "$1");
        return text;
      }

      case "stat-row":
        return (block.stats ?? [])
          .map((s) => `${s.label ?? "?"}: ${s.value ?? "?"}`)
          .join(" | ");

      case "progress": {
        const pct = Number.isFinite(block.percent) ? `${block.percent}%` : "?";
        return `[${pct}] ${block.label ?? ""}`;
      }

      case "code": {
        const title = block.title ? `${block.title}:\n` : "";
        return title + (block.content ?? "");
      }

      case "list": {
        const variant = block.variant ?? "unordered";
        return (block.items ?? [])
          .map((item, i) => {
            const prefix =
              variant === "ordered"
                ? `${i + 1}.`
                : variant === "checkbox"
                  ? item.checked
                    ? "☑"
                    : "☐"
                  : "•";
            return `${prefix} ${item.text}`;
          })
          .join("\n");
      }

      case "table": {
        const cols = block.columns ?? [];
        const rows = block.rows ?? [];
        if (cols.length === 0) return "(empty table)";
        // Header
        const header =
          "| " + cols.map((c) => c.label ?? c.key).join(" | ") + " |";
        const sep =
          "|" + cols.map(() => "---").join("|") + "|";
        // Rows
        const body = rows
          .map(
            (row) =>
              "| " +
              cols.map((c) => String(row[c.key] ?? "")).join(" | ") +
              " |",
          )
          .join("\n");
        return [block.caption ? `${block.caption}\n` : "", header, sep, body]
          .join("\n");
      }

      case "row":
        return (block.children ?? []).map(blockToText).join(" | ");

      case "custom":
        return block.fallbackText ?? `[custom: ${block.id}]`;

      default:
        return `[Unknown block: ${(block as any).type}]`;
    }
  } catch {
    return `[Block render error: ${block.key}]`;
  }
}

/**
 * Convert an array of blocks to a single text string for display.
 */
export function blocksToText(blocks: RenderBlock[]): string {
  try {
    return blocks.map(blockToText).join("\n");
  } catch {
    return "[Blocks render error]";
  }
}

/**
 * Convert a block for LLM context injection (spec §9.2).
 * Strips ANSI escapes, zero-width characters, and bidi overrides.
 * Wraps output in stable `<tool-output>` markers.
 * Caps at 50KB.
 */
export function blockToTextForLLM(block: RenderBlock): string {
  try {
    let text = blockToText(block)
      // Strip zero-width characters
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      // Strip bidi override characters
      .replace(/[\u202A-\u202E]/g, "")
      // Strip ANSI escape sequences
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

    if (text.length > 50_000) {
      text = text.slice(0, 50_000) + "\n... (truncated)";
    }

    return `<tool-output type="${block.type}" key="${block.key}">\n${text}\n</tool-output>`;
  } catch {
    return `<tool-output type="error" key="${block.key ?? "?"}">\n[Block render error]\n</tool-output>`;
  }
}

/**
 * Convert an array of blocks to LLM-ready text, joined without separator
 * — each block wraps itself in `<tool-output>` markers.
 */
export function blocksToTextForLLM(blocks: RenderBlock[]): string {
  try {
    return blocks.map(blockToTextForLLM).join("\n");
  } catch {
    return "\n[Blocks render error]\n";
  }
}
