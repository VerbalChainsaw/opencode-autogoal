/**
 * src/blocks/types.ts — RenderBlock type system per spec §2.
 *
 * Local mirror of the planned `@opencode-ai/sdk/blocks` types. When the SDK
 * ships the real types, these are replaced with direct imports.
 *
 * ALL types match specs/render-protocol-design.md §2.1–2.4 exactly.
 */

// ── Core block shape (spec §2.1) ────────────────────────────────────────────

export type RenderBlock = {
  key: string;             // stable identity, 1–64 chars, /^[a-zA-Z0-9_-]+$/
  version: number;         // schema version, positive integer
  streaming?: boolean;     // show loading/shimmer state
  sequence?: number;       // per-callID per-key monotonic counter
} & (
  | TextBlock
  | StatRowBlock
  | ProgressBlock
  | CodeBlock
  | ListBlock
  | TableBlock
  | RowBlock
  | CustomBlock
);

// ── Block type discriminators (spec §2.2) ───────────────────────────────────

export type BlockType =
  | "text"
  | "stat-row"
  | "progress"
  | "code"
  | "list"
  | "table"
  | "row"
  | "custom";

// ── Individual block shapes ─────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  content: string;  // markdown, capped at 50KB
}

export interface StatRowBlock {
  type: "stat-row";
  stats: Array<{
    label: string;
    value: string | number;
    variant?: "default" | "success" | "warning" | "error" | "info";
  }>;
}

export interface ProgressBlock {
  type: "progress";
  percent: number;           // 0–100 finite number, or -1 for indeterminate
  label?: string;
  variant?: "default" | "success" | "warning" | "error";
  segments?: Array<{
    label: string;
    current: number;
    max: number;
  }>;
}

export interface CodeBlock {
  type: "code";
  language: string;
  content: string;           // capped at 1MB
  title?: string;
  collapsed?: boolean;
  variant?: "default" | "shell" | "diff";
}

export interface ListBlock {
  type: "list";
  variant: "unordered" | "ordered" | "checkbox";
  items: Array<{
    text: string;
    checked?: boolean;       // checkbox variant only
    description?: string;
    meta?: string;
  }>;
}

export interface TableBlock {
  type: "table";
  columns: Array<{
    key: string;
    label: string;
    align?: "left" | "center" | "right";
  }>;
  rows: Array<Record<string, string | number | boolean | null>>;
  caption?: string;
}

export interface RowBlock {
  type: "row";
  children: RenderBlock[];
}

export interface CustomBlock {
  type: "custom";
  id: string;                // namespaced: "plugin-slug:block-id"
  data: Record<string, unknown>;
  fallbackText: string;      // REQUIRED — TUI fallback
}

// ── BlockAction (spec §2.3) ─────────────────────────────────────────────────

export interface BlockAction {
  id: string;
  label: string;
  tool: string;                    // must match registered tool name
  args?: Record<string, unknown>;
  variant?: "primary" | "secondary" | "destructive" | "ghost";
  disabled?: boolean;
  disabledReason?: string;
  confirm?: string;
  icon?: string;
}

// ── Block validation error (spec §4.1) ──────────────────────────────────────

export type BlockErrorCode =
  | "key_invalid"
  | "key_invalid_chars"
  | "key_reserved"
  | "key_duplicate"
  | "version_invalid"
  | "percent_invalid"
  | "content_too_large"
  | "too_many_stats"
  | "too_many_items"
  | "too_many_columns"
  | "too_many_rows"
  | "too_many_children"
  | "too_many_blocks"
  | "custom_id_not_namespaced"
  | "custom_missing_fallback"
  | "row_depth_exceeded"
  | "sequence_not_monotonic";

export interface BlockValidationError {
  key: string;         // "*" for global errors (too_many_blocks)
  error: BlockErrorCode;
}

// ── Validation result ───────────────────────────────────────────────────────

export interface ValidatedBlocks {
  valid: boolean;
  blocks: RenderBlock[];
  errors: BlockValidationError[];
}

// ── Diff types (spec §5) ────────────────────────────────────────────────────

export type DiffPhase = "enter" | "update" | "exit" | "same";

export interface DiffEntry {
  block: RenderBlock | null;
  prev: RenderBlock | null;
  phase: DiffPhase;
  changedFields?: string[];
}

export interface DiffResult {
  entries: DiffEntry[];
}
