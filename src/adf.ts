/**
 * Plain-text extraction from Atlassian Document Format (ADF).
 *
 * Each block (paragraph, heading, list item, ...) becomes its own line, so a
 * command reads to the end of the paragraph it starts in. Content a user did
 * not mean as a command is dropped: code blocks, inline code, quotes and
 * mentions, so pasting an example of the syntax does not set a reminder.
 */

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string }>;
  content?: AdfNode[];
}

const SKIPPED_NODES = new Set(['codeBlock', 'blockquote', 'mention', 'mediaSingle', 'mediaGroup', 'media']);

const INLINE_NODES = new Set(['text', 'hardBreak', 'emoji', 'inlineCard', 'date', 'status', 'mention']);

export function adfToText(body: unknown): string {
  if (typeof body === 'string') {
    return body;
  }
  if (!isNode(body)) {
    return '';
  }
  const lines: string[] = [];
  collectBlocks(body, lines);
  return lines
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function collectBlocks(node: AdfNode, lines: string[]): void {
  if (SKIPPED_NODES.has(node.type)) {
    return;
  }
  const children = node.content ?? [];
  if (children.some((child) => INLINE_NODES.has(child.type))) {
    lines.push(...inlineText(children).split('\n'));
    return;
  }
  for (const child of children) {
    collectBlocks(child, lines);
  }
}

function inlineText(nodes: AdfNode[]): string {
  let text = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        if (!node.marks?.some((mark) => mark.type === 'code')) {
          text += node.text ?? '';
        }
        break;
      case 'hardBreak':
        text += '\n';
        break;
      case 'emoji':
        text += typeof node.attrs?.text === 'string' ? node.attrs.text : '';
        break;
      case 'inlineCard':
        text += typeof node.attrs?.url === 'string' ? node.attrs.url : '';
        break;
      default:
        break;
    }
  }
  return text;
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === 'object' && value !== null && typeof (value as AdfNode).type === 'string';
}
