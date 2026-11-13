import {
  advanceNdfLexicalState,
  CHAR_CARRIAGE_RETURN,
  CHAR_LINE_FEED,
  createNdfLexicalState,
} from './chars.ts';

/**
 * Every `//` YMB reads or writes in an NDF file. A `leadingComment` sits above an
 * operation's output and explains the change; a `trailingComment` sits after one
 * rewritten value and records what it replaced. The reading half lives here too: a
 * comment YMB writes must be one the field splitter can take back off.
 */

/** Empty when there is nothing to say, so callers can always concatenate. */
export function renderLeadingComment(comment: string | undefined, indent: string): string {
  const normalized = comment?.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  return normalized
    .split('\n')
    .map((line) => `${indent}// ${line}`)
    .join('\n')
    .concat('\n');
}

/** The original is part of the comment: leaving a record beside the change is the point. */
export function renderTrailingComment(
  comment: string | undefined,
  replacedCode: string,
): string | undefined {
  return comment === undefined ? undefined : ` // ${comment} (was ${replacedCode})`;
}

/** Must agree with the splitter below; `includes('//')` read `"http://..."` as a comment. */
export function lineHasComment(text: string, lineEnd: number): boolean {
  const lineStart = text.lastIndexOf('\n', lineEnd - 1) + 1;
  return findLineCommentIndex(text, lineStart, lineEnd) !== -1;
}

/** Stops at the newline, and ignores a `//` inside a string. */
export function findLineCommentIndex(
  text: string,
  fromIndex: number,
  endIndex = text.length,
): number {
  const limit = Math.min(endIndex, text.length);
  const state = createNdfLexicalState();
  for (let index = fromIndex; index < limit; index += 1) {
    if (text.charCodeAt(index) === CHAR_LINE_FEED) {
      return -1;
    }
    const lexical = advanceNdfLexicalState(state, text, index);
    if (lexical === 'comment-start' && state.inLineComment) return index;
    if (lexical === 'comment-start') index += 1;
  }
  return -1;
}

/**
 * A comment after a value is part of the file, not the value. Only the last one
 * counts, and only when nothing follows it: a `//` partway through a multi-line
 * body has code after it and belongs to the value.
 */
export function splitTrailingComment(value: string): {
  code: string;
  trailingComment?: string | undefined;
} {
  const state = createNdfLexicalState();
  let trailingStart: number | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const wasString = state.inString;
    const lexical = advanceNdfLexicalState(state, value, index);
    if (lexical === 'comment-start') {
      trailingStart ??= index;
      index += 1;
      continue;
    }
    if (wasString || state.inString || (lexical === 'code' && !/\s/.test(value[index] ?? ''))) {
      trailingStart = undefined;
    }
  }

  if (trailingStart === undefined) {
    return { code: value };
  }
  return {
    code: value.slice(0, trailingStart).trimEnd(),
    trailingComment: value.slice(trailingStart),
  };
}

/** Re-attaches a trailing comment to a rewritten value. */
export function withTrailingComment(code: string, trailingComment: string | undefined): string {
  return trailingComment ? `${code} ${trailingComment}` : code;
}

export function stripComments(text: string): string {
  if (!text.includes('//') && !text.includes('/*')) return text;
  const parts: string[] = [];
  let keptFrom = 0;
  const state = createNdfLexicalState();

  for (let index = 0; index < text.length; index += 1) {
    const lexical = advanceNdfLexicalState(state, text, index);
    if (lexical === 'comment-start') {
      parts.push(text.slice(keptFrom, index));
      if (state.inBlockComment) {
        const close = text.indexOf('*/', index + 2);
        keptFrom = close === -1 ? text.length : close + 2;
        parts.push(text.slice(index, keptFrom).replace(/[^\r\n]/g, '') || ' ');
        index = keptFrom - 1;
        state.inBlockComment = false;
        continue;
      }
      const lineEnd = text.indexOf('\n', index + 2);
      if (lineEnd === -1) {
        return parts.join('');
      }
      // The line ending survives. On CRLF that means resuming at the carriage return, or
      // the file ends up with two kinds of line ending.
      keptFrom =
        lineEnd > index && text.charCodeAt(lineEnd - 1) === CHAR_CARRIAGE_RETURN
          ? lineEnd - 1
          : lineEnd;
      index = lineEnd;
      state.inLineComment = false;
    }
  }

  parts.push(text.slice(keptFrom));
  return parts.join('');
}
