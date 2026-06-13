/**
 * src/blocks/validate.ts — block validation per specs/render-protocol-design.md §4.1.
 *
 * `validateBlocks()` checks every block's shape, key, version, size caps,
 * nesting depth, and cardinality limits. Invalid blocks are filtered with
 * errors reported. If ALL blocks are invalid, a fallback text block is
 * synthesized so the tool output is never empty.
 *
 * Zero dependencies beyond ../blocks/types.ts and Node builtins.
 */

import type {
  RenderBlock,
  BlockValidationError,
  ValidatedBlocks,
  BlockErrorCode,
} from "./types.js";

// ── Constants (spec §4.1) ───────────────────────────────────────────────────

const KEY_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_KEY_LEN = 64;
const MAX_TEXT_CONTENT = 50_000;
const MAX_CODE_CONTENT = 1_000_000;
const MAX_STATS = 12;
const MAX_LIST_ITEMS = 200;
const MAX_COLUMNS = 100;
const MAX_ROWS = 200;
const MAX_ROW_CHILDREN = 6;
const MAX_TOTAL_BLOCKS = 256;
const MAX_NEST_DEPTH = 1;

const RESERVED_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
]);

// ── Sequence map — per-callID per-key tracking (spec §4.1 end) ──────────────

export interface SequenceMap {
  get(key: string): number | undefined;
  set(key: string, seq: number): void;
}

class DefaultSequenceMap implements SequenceMap {
  private map = new Map<string, number>();
  get(key: string): number | undefined { return this.map.get(key); }
  set(key: string, seq: number) { this.map.set(key, seq); }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate an array of RenderBlocks. Returns a `ValidatedBlocks` with filtered
 * valid blocks, a boolean flag, and error details.
 *
 * @param blocks - The blocks to validate.
 * @param previousSequenceMap - Optional per-callID per-key sequence tracker.
 */
export function validateBlocks(
  blocks: RenderBlock[],
  previousSequenceMap?: SequenceMap,
): ValidatedBlocks {
  const errors: BlockValidationError[] = [];
  const seen = new Set<string>();
  const seq = previousSequenceMap ?? new DefaultSequenceMap();

  // Total blocks cap (before per-block iteration)
  if (blocks.length > MAX_TOTAL_BLOCKS) {
    errors.push({ key: "*", error: "too_many_blocks" });
  }

  for (const block of blocks) {
    // ── Key validation ──
    if (!block.key || typeof block.key !== "string" || block.key.length === 0) {
      errors.push({ key: String(block.key ?? "(missing)"), error: "key_invalid" });
      continue;
    }
    if (block.key.length > MAX_KEY_LEN) {
      errors.push({ key: block.key, error: "key_invalid" });
      continue;
    }
    if (!KEY_RE.test(block.key)) {
      errors.push({ key: block.key, error: "key_invalid_chars" });
      continue;
    }
    if (RESERVED_KEYS.has(block.key)) {
      errors.push({ key: block.key, error: "key_reserved" });
      continue;
    }
    if (seen.has(block.key)) {
      errors.push({ key: block.key, error: "key_duplicate" });
      continue;
    }
    seen.add(block.key);

    // ── Version validation ──
    if (!Number.isFinite(block.version) || block.version < 1) {
      errors.push({ key: block.key, error: "version_invalid" });
      continue;
    }

    // ── Numeric field guards ──
    if (block.type === "progress" && !Number.isFinite(block.percent) && (block.percent as number) !== -1) {
      errors.push({ key: block.key, error: "percent_invalid" });
      continue;
    }

    // ── Size caps ──
    if (block.type === "text" && block.content.length > MAX_TEXT_CONTENT) {
      errors.push({ key: block.key, error: "content_too_large" });
    }
    if (block.type === "code" && block.content.length > MAX_CODE_CONTENT) {
      errors.push({ key: block.key, error: "content_too_large" });
    }
    if (block.type === "stat-row" && block.stats.length > MAX_STATS) {
      errors.push({ key: block.key, error: "too_many_stats" });
      continue;
    }
    if (block.type === "list" && block.items.length > MAX_LIST_ITEMS) {
      errors.push({ key: block.key, error: "too_many_items" });
      continue;
    }
    if (block.type === "table") {
      if (block.columns.length > MAX_COLUMNS) {
        errors.push({ key: block.key, error: "too_many_columns" });
        continue;
      }
      if (block.rows.length > MAX_ROWS) {
        errors.push({ key: block.key, error: "too_many_rows" });
        continue;
      }
    }
    if (block.type === "row") {
      if (block.children.length > MAX_ROW_CHILDREN) {
        errors.push({ key: block.key, error: "too_many_children" });
        continue;
      }
      if (!validateRowDepth(block, 0)) {
        errors.push({ key: block.key, error: "row_depth_exceeded" });
        continue;
      }
    }

    // ── Custom block guards ──
    if (block.type === "custom") {
      if (!block.id.includes(":")) {
        errors.push({ key: block.key, error: "custom_id_not_namespaced" });
        continue;
      }
      if (!block.fallbackText) {
        errors.push({ key: block.key, error: "custom_missing_fallback" });
        continue;
      }
    }

    // ── Sequence ordering check (scoped to callID:key via the sequence map) ──
    if (block.sequence !== undefined) {
      const prev = seq.get(block.key);
      if (prev !== undefined && block.sequence <= prev) {
        errors.push({ key: block.key, error: "sequence_not_monotonic" });
        continue;
      }
      seq.set(block.key, block.sequence);
    }
  }

  // Filter valid blocks (those without errors keyed by their key)
  const valid = blocks.filter(
    (b) => !errors.some((e) => e.key === b.key),
  );

  // Never strip ALL blocks — synthesize fallback (spec §4.1 line 361-373)
  if (valid.length === 0 && blocks.length > 0) {
    return {
      valid: false,
      blocks: [
        {
          key: "_fallback",
          type: "text" as const,
          version: 1,
          content: `Tool produced ${blocks.length} block(s), but all failed validation.`,
        } satisfies RenderBlock,
      ],
      errors,
    };
  }

  return { valid: errors.length === 0, blocks: valid, errors };
}

// ── Depth guard (spec §4.1 line 378-383) ────────────────────────────────────

function validateRowDepth(block: RenderBlock, depth: number): boolean {
  if (block.type !== "row") return true;
  if (depth >= MAX_NEST_DEPTH) return false;
  return block.children.every((child) => validateRowDepth(child, depth + 1));
}

// ── Prototype pollution guard (spec §4.4) ───────────────────────────────────

/**
 * Sanitize a block's keys to prevent prototype pollution. Strips reserved
 * keys from any object at ingress. Called before blocks enter any store.
 * Returns a shallow copy of the block with reserved keys stripped.
 */
export function sanitizeBlock(obj: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(obj)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      cleaned[key] = sanitizeBlock(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      cleaned[key] = value.map((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? sanitizeBlock(item as Record<string, unknown>)
          : item,
      );
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}
