use crate::{Diagnostic, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Word,
    Literal,
    Symbol,
    Eof,
}

#[derive(Clone, Copy, Debug)]
pub struct Token<'a> {
    pub text: &'a str,
    pub start: usize,
    pub end: usize,
    pub kind: Kind,
}

#[derive(Clone)]
pub struct Lexer<'a> {
    pub source: &'a str,
    pub cursor: usize,
}

impl<'a> Lexer<'a> {
    pub fn new(source: &'a str, cursor: usize) -> Self {
        Self { source, cursor }
    }
    pub fn next_token(&mut self) -> Result<Token<'a>> {
        if self.cursor > self.source.len() || !self.source.is_char_boundary(self.cursor) {
            return Err(error(
                self.source,
                self.cursor,
                "E34",
                crate::messages::text("ndf.lexer.next_token.invalid_source_offset"),
                crate::messages::text("ndf.lexer.next_token.use_a_utf_8_byte_boundary_within"),
            ));
        }
        let bytes = self.source.as_bytes();
        while self.cursor < bytes.len() {
            let at = self.cursor;
            if bytes[at].is_ascii_whitespace() {
                self.cursor += 1;
                continue;
            }
            if bytes[at] >= 128 {
                let c = self.source[at..].chars().next().unwrap();
                if c.is_whitespace() || c == '\u{feff}' {
                    self.cursor += c.len_utf8();
                    continue;
                }
            }
            if bytes[at..].starts_with(b"//") {
                self.cursor = self.source[at..]
                    .find('\n')
                    .map_or(bytes.len(), |n| at + n + 1);
                continue;
            }
            if bytes[at..].starts_with(b"/*") {
                let Some(end) = self.source[at + 2..].find("*/") else {
                    return Err(error(
                        self.source,
                        at,
                        "E35",
                        crate::messages::text("ndf.lexer.next_token.unclosed_block_comment"),
                        crate::messages::text("ndf.lexer.next_token.close_the_comment_with"),
                    ));
                };
                self.cursor = at + end + 4;
                continue;
            }
            break;
        }
        let start = self.cursor;
        if start == bytes.len() {
            return Ok(Token {
                text: "",
                start,
                end: start,
                kind: Kind::Eof,
            });
        }
        let first = bytes[start];

        let kind = if matches!(first, b'\'' | b'"') {
            self.cursor += 1;
            let mut closed = false;
            while self.cursor < bytes.len() {
                let current = bytes[self.cursor];
                self.cursor += 1;
                if current == b'\\' {
                    if self.cursor < bytes.len() {
                        self.cursor += 1;
                    }
                } else if current == first {
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err(error(
                    self.source,
                    start,
                    "E36",
                    crate::messages::text("ndf.lexer.next_token.unclosed_string"),
                    crate::messages::text(
                        "ndf.lexer.next_token.close_the_string_with_the_same_quote",
                    ),
                ));
            }
            Kind::Literal
        } else if self.source[start..].starts_with("GUID") && guid_end(self.source, start).is_some()
        {
            self.cursor = guid_end(self.source, start).unwrap();
            Kind::Literal
        } else if matches!(first, b'$' | b'~') && bytes.get(start + 1) == Some(&b'/') {
            self.cursor += 1;
            while self.cursor < bytes.len()
                && (identifier_byte(bytes[self.cursor]) || b"/@.-".contains(&bytes[self.cursor]))
            {
                self.cursor += 1;
            }
            Kind::Word
        } else if first.is_ascii_digit()
            || (first == b'.' && bytes.get(start + 1).is_some_and(u8::is_ascii_digit))
        {
            self.cursor = number_end(bytes, start);
            Kind::Literal
        } else if first.is_ascii_alphabetic() || first == b'_' {
            self.cursor += 1;
            while self.cursor < bytes.len() && identifier_byte(bytes[self.cursor]) {
                self.cursor += 1;
            }
            while bytes.get(self.cursor) == Some(&b'/')
                && bytes
                    .get(self.cursor + 1)
                    .is_some_and(|b| identifier_byte(*b) || b"@.-".contains(b))
            {
                self.cursor += 1;
                while self.cursor < bytes.len()
                    && (identifier_byte(bytes[self.cursor]) || b"@.-".contains(&bytes[self.cursor]))
                {
                    self.cursor += 1;
                }
            }
            Kind::Word
        } else {
            self.cursor += self.source[start..].chars().next().unwrap().len_utf8();
            if b"=!<>".contains(&first) && bytes.get(self.cursor) == Some(&b'=') {
                self.cursor += 1;
            }
            Kind::Symbol
        };
        Ok(Token {
            text: &self.source[start..self.cursor],
            start,
            end: self.cursor,
            kind,
        })
    }
}

pub fn identifier_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn guid_end(source: &str, start: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut cursor = start + 4;
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b':') {
        return None;
    }
    cursor += 1;
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b'{') {
        return None;
    }
    cursor += 1;
    let content = cursor;
    // Decooked GUID literals can contain non-hex letters; preserve their spelling.
    while bytes
        .get(cursor)
        .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'-')
    {
        cursor += 1;
    }
    if cursor == content || bytes.get(cursor) != Some(&b'}') {
        None
    } else {
        Some(cursor + 1)
    }
}

fn number_end(bytes: &[u8], mut cursor: usize) -> usize {
    if bytes[cursor] == b'0'
        && matches!(bytes.get(cursor + 1), Some(b'x' | b'X'))
        && bytes.get(cursor + 2).is_some_and(u8::is_ascii_hexdigit)
    {
        cursor += 2;
        while bytes.get(cursor).is_some_and(u8::is_ascii_hexdigit) {
            cursor += 1;
        }
        return cursor;
    }
    while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        cursor += 1;
    }
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
    }
    if matches!(bytes.get(cursor), Some(b'e' | b'E')) {
        let exponent = cursor;
        cursor += 1;
        if matches!(bytes.get(cursor), Some(b'+' | b'-')) {
            cursor += 1;
        }
        let digits = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if digits == cursor {
            cursor = exponent;
        }
    }
    cursor
}

pub fn error(
    source: &str,
    at: usize,
    code: &str,
    reason: &str,
    suggestion: &str,
) -> Box<Diagnostic> {
    Diagnostic::new("ParserError", reason, suggestion)
        .code(code)
        .located(source, at)
}
