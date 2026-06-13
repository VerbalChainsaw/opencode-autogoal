/**
 * format.ts — zero-dep terminal formatting primitives shared by the CLI
 * polish pass and the interactive control center (control-center-logic.ts).
 *
 * No third-party imports — only ANSI SGR strings and string math. Everything
 * here is pure and unit-tested; the impure render loop lives in
 * control-center.ts. Color is opt-in via `enabled` (the caller decides from
 * `supportsColor`), so the same code paths run with or without a TTY and the
 * `--json` / prose-identity output is never colorized.
 */

// ── SGR codes ───────────────────────────────────────────────────────────────
const SGR: Record<string, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
  white: [37, 39],
};

export type StyleName = keyof typeof SGR;
export type Styler = Record<StyleName, (s: string) => string>;

/**
 * Build a styler whose methods wrap text in SGR when `enabled`, or return the
 * text unchanged otherwise. An empty string is always returned bare (no codes
 * around nothing). Each call uses the precise reset code for that attribute
 * (e.g. 39 for color, 22 for bold) so nested styling composes cleanly.
 */
export function createStyler(enabled: boolean): Styler {
  const out = {} as Styler;
  for (const name of Object.keys(SGR) as StyleName[]) {
    const [on, off] = SGR[name]!;
    out[name] = enabled
      ? (s: string) => (s.length === 0 ? s : `\x1b[${on}m${s}\x1b[${off}m`)
      : (s: string) => s;
  }
  return out;
}

/**
 * Decide whether to emit color for a given output stream. True only when the
 * stream is a TTY AND `NO_COLOR` is absent from the environment. Per the
 * NO_COLOR convention (https://no-color.org), ANY value — including an empty
 * string — disables color, so we test for key presence, not truthiness.
 */
export function supportsColor(
  stream: { isTTY?: boolean } | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!stream || !stream.isTTY) return false;
  if (Object.prototype.hasOwnProperty.call(env, "NO_COLOR")) return false;
  return true;
}

// ── String math (SGR-aware) ──────────────────────────────────────────────────
const SGR_RE = /\x1b\[[0-9;]*m/g;

/** Visible width of a string: SGR sequences stripped, then code points counted
 *  (Array.from handles surrogate pairs). Wide-character handling is out of
 *  scope — every code point counts as width 1, matching the existing `watch`. */
export function visibleWidth(s: string): number {
  return Array.from(s.replace(SGR_RE, "")).length;
}

/** Truncate a PLAIN string to `width` visible columns, appending "…" when it
 *  overflows so the result is exactly `width` wide. width <= 0 → empty. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(s);
  if (chars.length <= width) return s;
  return chars.slice(0, width - 1).join("") + "…";
}

/** Right-pad a PLAIN string with spaces to `width`; never shrinks. */
export function padEnd(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/**
 * Render a 2-D array of PLAIN-text cells as aligned columns. Each column is
 * padded to the widest cell in that column; columns are separated by a
 * `gutter`-wide space run; trailing whitespace is trimmed per line. Color the
 * cells BEFORE calling if needed — pass already-styled strings and the widths
 * stay correct because `visibleWidth` ignores SGR.
 */
export function renderTable(rows: string[][], opts: { gutter?: number } = {}): string[] {
  if (rows.length === 0) return [];
  const gutter = opts.gutter ?? 2;
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(0, ...rows.map((r) => visibleWidth(r[c] ?? "")));
  }
  const sep = " ".repeat(gutter);
  return rows.map((r) => {
    const cells = [];
    for (let c = 0; c < cols; c++) cells.push(padEnd(r[c] ?? "", widths[c]!));
    return cells.join(sep).replace(/\s+$/, "");
  });
}
