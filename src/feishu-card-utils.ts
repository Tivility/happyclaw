/**
 * Shared utilities for building Feishu card elements.
 * Used by both feishu.ts (static cards) and feishu-streaming-card.ts (streaming cards).
 *
 * Key feature: converts markdown tables to native Feishu table components,
 * since the Feishu card `markdown` element does NOT support pipe-separated table syntax.
 */

export const CARD_MD_LIMIT = 4000;

/**
 * Split long text at paragraph boundaries to fit within card element limits.
 */
export function splitAtParagraphs(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Prefer splitting at double newline (paragraph break)
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) {
      // Fallback to single newline
      idx = remaining.lastIndexOf('\n', maxLen);
    }
    if (idx < maxLen * 0.3) {
      // Hard split as last resort
      idx = maxLen;
    }
    chunks.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}

// ─── Table Parsing ─────────────────────────────────────────────

/** Check if a line looks like a markdown table row (starts and ends with |) */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('|') &&
    trimmed.endsWith('|') &&
    trimmed.split('|').length >= 3
  );
}

/** Check if a line is a markdown table separator (e.g., |---|---|) */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return false;
  const cells = trimmed.split('|').slice(1, -1);
  return (
    cells.length > 0 && cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c))
  );
}

interface ContentSegment {
  type: 'text' | 'table';
  content: string;
}

/**
 * Split content into alternating text and table segments.
 * A valid table needs a header row, a separator row, and at least one data row.
 */
function splitContentIntoSegments(text: string): ContentSegment[] {
  const lines = text.split('\n');
  const segments: ContentSegment[] = [];
  let textLines: string[] = [];
  let tableLines: string[] = [];
  let inTable = false;

  const flushText = () => {
    if (textLines.length > 0) {
      const content = textLines.join('\n');
      if (content.trim()) segments.push({ type: 'text', content: content.trim() });
      textLines = [];
    }
  };

  const flushTable = () => {
    // Valid table: at least 3 lines (header + separator + 1 data row)
    // and the second line must be a separator
    if (tableLines.length >= 3 && isTableSeparator(tableLines[1])) {
      segments.push({ type: 'table', content: tableLines.join('\n') });
    } else {
      // Not a valid table, treat as text
      textLines.push(...tableLines);
    }
    tableLines = [];
  };

  for (const line of lines) {
    if (isTableRow(line)) {
      if (!inTable) {
        flushText();
        inTable = true;
      }
      tableLines.push(line);
    } else {
      if (inTable) {
        flushTable();
        inTable = false;
      }
      textLines.push(line);
    }
  }

  // Flush remaining
  if (inTable) flushTable();
  flushText();

  return segments;
}

interface ParsedTable {
  columns: Array<{ name: string; display_name: string }>;
  rows: Array<Record<string, string>>;
}

/**
 * Parse markdown table text into structured column/row data.
 */
function parseMarkdownTable(tableText: string): ParsedTable | null {
  const lines = tableText
    .split('\n')
    .filter((l) => l.trim());
  if (lines.length < 3) return null;

  // Parse header cells
  const headerCells = lines[0]
    .split('|')
    .slice(1, -1)
    .map((s) => s.trim());
  if (headerCells.length === 0) return null;

  // Validate separator
  if (!isTableSeparator(lines[1])) return null;

  // Build columns
  const columns = headerCells.map((cell, idx) => ({
    name: `col_${idx}`,
    display_name: cell,
  }));

  // Parse data rows
  const rows: Array<Record<string, string>> = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i]
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim());
    const row: Record<string, string> = {};
    columns.forEach((col, idx) => {
      row[col.name] = cells[idx] || '';
    });
    rows.push(row);
  }

  return { columns, rows };
}

// ─── Markdown Preprocessing ──────────────────────────────────

/**
 * Preprocess markdown text for Feishu card rendering.
 * Feishu card `markdown` element does NOT support:
 *   - Headings (# / ## / ###) → converted to bold text
 *   - Blockquotes (>) → converted to grey text with visual bar
 * Code blocks are preserved as-is.
 */
export function preprocessMarkdownForFeishu(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Track code block boundaries
    if (/^```/.test(line.trimStart())) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // Convert headings to bold
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      // Strip trailing # markers (e.g., "## Heading ##")
      const headingText = headingMatch[1].replace(/\s+#+\s*$/, '').trim();
      result.push(`**${headingText}**`);
      continue;
    }

    // Convert blockquotes to grey text with visual bar
    if (/^>\s?/.test(line)) {
      const content = line.replace(/^(?:>\s?)+/, '').trim();
      result.push(content ? `<font color="grey">｜${content}</font>` : '');
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}

// ─── Element Building ──────────────────────────────────────────

/**
 * Build Feishu card elements from content string.
 * Converts markdown tables to native Feishu table components.
 * Text segments preserve --- separators as `hr` elements.
 * Applies preprocessMarkdownForFeishu() to text segments.
 */
export function buildContentElements(content: string): {
  elements: Array<Record<string, unknown>>;
  hasTable: boolean;
} {
  const segments = splitContentIntoSegments(content);
  const elements: Array<Record<string, unknown>> = [];
  let hasTable = false;

  for (const segment of segments) {
    if (segment.type === 'table') {
      const parsed = parseMarkdownTable(segment.content);
      if (parsed) {
        hasTable = true;
        elements.push({
          tag: 'table',
          page_size: parsed.rows.length,
          row_height: 'low',
          header_style: {
            text_align: 'left',
            text_size: 'normal',
            background_style: 'grey',
            bold: true,
            lines: 1,
          },
          columns: parsed.columns.map((col) => ({
            name: col.name,
            display_name: col.display_name,
            data_type: 'lark_md',
            width: 'auto',
          })),
          rows: parsed.rows,
        });
        continue;
      }
      // Parsing failed, fall back to markdown
      elements.push({ tag: 'markdown', content: segment.content });
    } else {
      // Apply markdown preprocessing for Feishu card compatibility
      const text = preprocessMarkdownForFeishu(segment.content);
      if (!text) continue;

      // Handle --- separators within text
      const sections = text.split(/\n-{3,}\n/);
      for (let i = 0; i < sections.length; i++) {
        if (i > 0) elements.push({ tag: 'hr' });
        const s = sections[i].trim();
        if (!s) continue;
        if (s.length > CARD_MD_LIMIT) {
          const chunks = splitAtParagraphs(s, CARD_MD_LIMIT);
          for (const chunk of chunks) {
            elements.push({ tag: 'markdown', content: chunk });
          }
        } else {
          elements.push({ tag: 'markdown', content: s });
        }
      }
    }
  }

  return { elements, hasTable };
}

/**
 * Wrap card elements in the appropriate card JSON format.
 * Uses Card JSON 2.0 when tables are present (required for table component),
 * Card JSON 1.0 otherwise for maximum compatibility.
 */
export function wrapCardJson(
  elements: Array<Record<string, unknown>>,
  hasTable: boolean,
  header?: { title: { tag: string; content: string }; template: string },
): Record<string, unknown> {
  if (hasTable) {
    // Card JSON 2.0 (required for table component)
    const card: Record<string, unknown> = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      body: { elements },
    };
    if (header) card.header = header;
    return card;
  }

  // Card JSON 1.0 (default)
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true },
    elements,
  };
  if (header) card.header = header;
  return card;
}
