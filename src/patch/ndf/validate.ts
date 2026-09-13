import type { CooperativeYieldController } from '../../async.ts';
import { YmbError } from '../../errors.ts';
import { advanceStringState, isWhitespaceCode, startsLineComment } from './chars.ts';

/** Also guards replace outputs, script outputs, and every tracked file YMB reads. */
export function isNdfPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.ndf');
}

export function validateNdf(text: string, absolutePath: string): void {
  for (const _ of new NdfValidator(text, absolutePath).document()) {
    // The synchronous and cooperative paths consume the same grammar.
  }
}

export async function validateNdfCooperative(
  text: string,
  absolutePath: string,
  yieldController: CooperativeYieldController,
): Promise<void> {
  for (const _ of new NdfValidator(text, absolutePath).document()) {
    await yieldController.maybeYield();
  }
}

const OPERATORS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  'div',
  'mod',
  'and',
  'or',
  'xor',
  'in',
]);
const MODIFIERS = new Set(['export', 'private', 'public']);

/** A forward-only recognizer: retain one token, not an AST of multi-megabyte game files. */
class NdfValidator {
  private cursor = 0;
  private start = 0;
  private token = '';
  private kind: 'word' | 'literal' | 'symbol' | 'eof' = 'eof';
  private lastYield = 0;
  private depth = 0;
  private readonly number = /(?:0x[\da-f]+|(?:\d+(?:\.\d*)?|\.\d+))/iy;
  private readonly word = /[A-Za-z_][A-Za-z_0-9]*(?:\/[A-Za-z_0-9@.-]+)*/y;
  private readonly reference = /[$~](?:\/[A-Za-z_0-9@.-]*)+/y;
  private readonly guid = /GUID\s*:\s*\{[\da-f-]+\}/iy;

  constructor(
    private readonly text: string,
    private readonly absolutePath: string,
  ) {
    this.advance();
  }

  *document(): Generator<void> {
    let first = true;
    while (this.kind !== 'eof') {
      const declared = yield* this.declaration(false);
      if (!declared && (!first || !this.at(''))) {
        this.fail(
          'ndf.expected_declaration',
          'Expected a named NDF declaration.',
          'Write `Name is Value` for each top-level definition. A standalone value must be the entire snippet.',
        );
      }
      first = false;
    }
  }

  private *declaration(member: boolean): Generator<void, boolean> {
    while (MODIFIERS.has(this.token)) this.advance();
    if (this.take('template')) {
      this.identifier();
      this.expect('[', 'Open the template parameter list with `[`.');
      while (!this.at(']')) {
        this.identifier();
        if (this.take(':')) yield* this.type();
        if (this.take('=')) yield* this.expression();
        if (!this.separator(']')) break;
      }
      this.expect(']', 'Close the template parameter list with `]`.');
      this.expect('is', 'Put `is` between the template parameters and its body.');
      yield* this.expression();
      return true;
    } else if (!member && this.take('unnamed')) {
      yield* this.expression();
      return true;
    } else if (member) {
      this.identifier();
      const typed = this.take(':');
      if (typed) yield* this.type();
      if (!this.take('=') && !this.take('is')) {
        if (typed) return true;
        this.fail(
          'ndf.expected_assignment',
          'Expected `=` for a member or `is` for a named declaration.',
          'Write `Member = Value` or `Name is Type(...)`. Put anonymous objects inside a member value or collection.',
        );
      }
      yield* this.expression();
      return true;
    } else {
      // The public validation tool also accepts standalone NDF values and collections.
      return yield* this.expression();
    }
  }

  private *type(): Generator<void> {
    this.enter();
    this.identifier();
    if (this.take('<')) {
      yield* this.type();
      while (this.take(',')) yield* this.type();
      this.expect('>', 'Close the type parameters with `>`.');
    }
    if (this.take('[')) {
      while (!this.at(']')) {
        if (['<', '>', '<=', '>=', '==', '!='].includes(this.token)) {
          this.advance();
          yield* this.expression();
        } else {
          this.identifier();
          if (this.take('=')) yield* this.expression();
        }
        if (!this.separator(']')) break;
      }
      this.expect(']', 'Close the type attributes with `]`.');
    }
    this.depth--;
  }

  private *expression(): Generator<void, boolean> {
    if (this.cursor - this.lastYield >= 4096) {
      this.lastYield = this.cursor;
      yield;
    }
    this.enter();
    const declared = yield* this.atom();
    while (OPERATORS.has(this.token)) {
      this.advance();
      yield* this.atom();
    }
    if (this.take('?')) {
      yield* this.expression();
      this.expect(':', 'Separate the two conditional values with `:`.');
      yield* this.expression();
    }
    this.depth--;
    return declared;
  }

  private *atom(): Generator<void, boolean> {
    while (this.at('+') || this.at('-') || this.at('!')) this.advance();
    if (this.take('<')) {
      this.identifier();
      this.expect('>', 'Close the template parameter reference with `>`.');
    } else if (this.kind === 'literal') {
      this.advance();
    } else if (this.kind === 'word') {
      while (MODIFIERS.has(this.token)) this.advance();
      this.identifier();
      if (this.take('is')) {
        yield* this.expression();
        return true;
      }
      if (this.take('(')) {
        while (!this.at(')')) {
          if (this.at('') || this.at(']') || this.at('}')) {
            this.expect(
              ')',
              'Close the object with `)` before closing its surrounding collection.',
            );
          }
          yield* this.declaration(true);
        }
        this.expect(')', 'Close the object with `)`.');
      }
    } else if (this.take('[')) {
      yield* this.collection(']');
    } else if (this.take('(')) {
      yield* this.expression();
      if (this.take(',')) yield* this.expression();
      this.expect(')', 'Close the expression or pair with `)`.');
    } else {
      this.fail(
        'ndf.expected_value',
        'Expected an NDF value.',
        'Supply a number, string, reference, object or collection. Check the preceding assignment, operator or comma.',
      );
    }
    while (this.at('[') || this.at('.')) {
      if (this.take('.')) this.identifier();
      else {
        this.advance();
        yield* this.collection(']');
      }
    }
    return false;
  }

  private *collection(close: string): Generator<void> {
    while (!this.at(close)) {
      yield* this.expression();
      if (!this.separator(close)) break;
    }
    this.expect(close, `Close the collection with \`${close}\`.`);
  }

  private separator(close: string): boolean {
    if (this.at(close)) return false;
    this.expect(
      ',',
      'Separate collection entries with a comma. A single trailing comma is allowed.',
    );
    return true;
  }

  private identifier(): void {
    if (this.kind !== 'word') {
      this.fail(
        'ndf.expected_name',
        'Expected an NDF name.',
        'Supply a member, declaration or parameter name at this position.',
      );
    }
    this.advance();
  }

  private at(token: string): boolean {
    return this.token === token;
  }
  private enter(): void {
    if (++this.depth > 256) {
      this.fail(
        'ndf.nesting_limit',
        'NDF expressions are nested too deeply.',
        'Split deeply nested expressions into named definitions.',
      );
    }
  }
  private take(token: string): boolean {
    if (!this.at(token)) return false;
    this.advance();
    return true;
  }
  private expect(token: string, suggestion: string): void {
    if (!this.take(token)) this.fail('ndf.expected_token', `Expected \`${token}\`.`, suggestion);
  }

  private match(pattern: RegExp, kind: 'word' | 'literal'): boolean {
    pattern.lastIndex = this.cursor;
    const match = pattern.exec(this.text);
    if (!match) return false;
    this.token = match[0];
    this.cursor = pattern.lastIndex;
    this.kind = kind;
    return true;
  }

  private advance(): void {
    while (this.cursor < this.text.length) {
      const index = this.cursor;
      const code = this.text.charCodeAt(index);
      if (isWhitespaceCode(code)) {
        this.cursor++;
        continue;
      }
      if (startsLineComment(this.text, index)) {
        const end = this.text.indexOf('\n', index + 2);
        this.cursor = end < 0 ? this.text.length : end + 1;
        continue;
      }
      if (this.text.startsWith('/*', index)) {
        const end = this.text.indexOf('*/', index + 2);
        if (end < 0)
          this.fail(
            'ndf.unclosed_comment',
            'Unclosed block comment.',
            'Close this comment with `*/`.',
            index,
          );
        this.cursor = end + 2;
        continue;
      }
      break;
    }
    this.start = this.cursor;
    if (this.cursor === this.text.length) {
      this.token = '';
      this.kind = 'eof';
      return;
    }
    const character = this.text.charAt(this.cursor);
    if (character === '"' || character === "'") {
      const open = this.cursor++;
      while (this.cursor < this.text.length) {
        if (advanceStringState(character, this.text, this.cursor++) === undefined) {
          this.kind = 'literal';
          this.token = 'string';
          return;
        }
      }
      this.fail(
        'ndf.unclosed_string',
        'Unclosed string.',
        'Close the string with the same quote character that opened it.',
        open,
      );
    }
    if (character === 'G' && this.match(this.guid, 'literal')) return;
    if ((character === '$' || character === '~') && this.match(this.reference, 'word')) return;
    if (
      ((character >= '0' && character <= '9') || character === '.') &&
      this.match(this.number, 'literal')
    )
      return;
    if (this.match(this.word, 'word')) return;
    this.kind = 'symbol';
    this.token = character;
    this.cursor++;
    if ('=!<>'.includes(character) && this.text[this.cursor] === '=') {
      this.token += '=';
      this.cursor++;
    }
  }

  private fail(code: string, reason: string, suggestion: string, offset = this.start): never {
    let line = 1;
    let lineStart = 0;
    for (let index = 0; index < offset; index++) {
      if (this.text.charCodeAt(index) === 10) {
        line++;
        lineStart = index + 1;
      }
    }
    const column = offset - lineStart + 1;
    const lineEnd = this.text.indexOf('\n', offset);
    const excerptStart = Math.max(lineStart, offset - 80);
    const excerpt = this.text
      .slice(excerptStart, Math.min(lineEnd < 0 ? this.text.length : lineEnd, offset + 120))
      .replace(/\r$/, '');
    throw new YmbError('ParserError', {
      absolutePath: this.absolutePath,
      code,
      line,
      column,
      offset,
      reason: `${reason} At line ${line}, column ${column}.`,
      suggestion,
      details: [excerpt, `${this.text.slice(excerptStart, offset).replace(/[^\t]/g, ' ')}^`],
    });
  }
}
