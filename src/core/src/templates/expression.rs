use super::*;

#[derive(Debug, Clone)]
pub(super) enum Expr {
    Literal(Value),
    Name(String),
    Array(Vec<Expr>),
    Unary(String, Box<Expr>),
    Binary(String, Box<Expr>, Box<Expr>),
    Conditional(Box<Expr>, Box<Expr>, Box<Expr>),
    Member(Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
}

#[derive(Clone, Debug)]
pub(super) struct Token {
    pub(super) text: String,
    pub(super) literal: Option<Value>,
    pub(super) name: bool,
}
pub(super) struct Parser {
    pub(super) tokens: Vec<Token>,
    pub(super) cursor: usize,
    pub(super) depth: usize,
}
impl Parser {
    pub(super) fn new(source: &str) -> Result<Self> {
        if source.len() > 1_048_576 {
            return Err(error(crate::messages::text(
                "templates.expression.new.expression_exceeds_the_size_limit",
            )));
        }
        let mut tokens = Vec::new();
        let mut cursor = 0;
        let bytes = source.as_bytes();
        while cursor < bytes.len() {
            let ch = source[cursor..].chars().next().unwrap();
            if ch.is_whitespace() {
                cursor += ch.len_utf8();
                continue;
            }
            let start = cursor;
            if ch == '\'' || ch == '"' {
                cursor += 1;
                let mut value = String::new();
                let mut closed = false;
                while cursor < bytes.len() {
                    let current = source[cursor..].chars().next().unwrap();
                    cursor += current.len_utf8();
                    if current == ch {
                        closed = true;
                        break;
                    }
                    if current == '\\' {
                        let escaped = source[cursor..].chars().next().ok_or_else(|| {
                            error(crate::messages::text(
                                "templates.expression.new.unclosed_string_escape",
                            ))
                        })?;
                        cursor += escaped.len_utf8();
                        match escaped {
                            'n' => value.push('\n'),
                            'r' => value.push('\r'),
                            't' => value.push('\t'),
                            'b' => value.push('\u{8}'),
                            'f' => value.push('\u{c}'),
                            'u' => {
                                let end = cursor + 4;
                                let digits = source.get(cursor..end).ok_or_else(|| {
                                    error(crate::messages::text(
                                        "templates.expression.new.invalid_unicode_escape",
                                    ))
                                })?;
                                let code = u32::from_str_radix(digits, 16)
                                    .ok()
                                    .and_then(char::from_u32)
                                    .ok_or_else(|| {
                                        error(crate::messages::text(
                                            "templates.expression.new.invalid_unicode_escape",
                                        ))
                                    })?;
                                value.push(code);
                                cursor = end;
                            }
                            other => value.push(other),
                        }
                    } else {
                        value.push(current);
                    }
                }
                if !closed {
                    return Err(error(crate::messages::text(
                        "templates.expression.new.unclosed_expression_string",
                    )));
                }
                tokens.push(Token {
                    text: source[start..cursor].into(),
                    literal: Some(Value::String(value)),
                    name: false,
                });
            } else if ch.is_ascii_digit()
                || (ch == '.' && bytes.get(cursor + 1).is_some_and(u8::is_ascii_digit))
            {
                cursor += 1;
                while bytes
                    .get(cursor)
                    .is_some_and(|b| b.is_ascii_digit() || *b == b'.')
                {
                    cursor += 1;
                }
                if bytes.get(cursor - 1) == Some(&b'.') {
                    return Err(error(crate::messages::text(
                        "templates.expression.new.a_decimal_point_must_be_followed_by",
                    )));
                }
                if matches!(bytes.get(cursor), Some(b'e' | b'E')) {
                    cursor += 1;
                    if matches!(bytes.get(cursor), Some(b'+' | b'-')) {
                        cursor += 1;
                    }
                    while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
                        cursor += 1;
                    }
                }
                let value: f64 = source[start..cursor].parse().map_err(|_| {
                    error(crate::messages::text(
                        "templates.expression.new.invalid_expression_number",
                    ))
                })?;
                tokens.push(Token {
                    text: source[start..cursor].into(),
                    literal: Some(number(value)?),
                    name: false,
                });
            } else if ch.is_ascii_alphabetic() || ch == '_' || ch == '$' {
                cursor += 1;
                while bytes
                    .get(cursor)
                    .is_some_and(|b| b.is_ascii_alphanumeric() || b"_$".contains(b))
                {
                    cursor += 1;
                }
                tokens.push(Token {
                    text: source[start..cursor].into(),
                    literal: None,
                    name: true,
                });
            } else {
                cursor += ch.len_utf8();
                if ["&&", "||", "==", "!=", "<=", ">="]
                    .iter()
                    .any(|s| source[start..].starts_with(s))
                {
                    cursor = start + 2;
                }
                let text = &source[start..cursor];
                if !matches!(
                    text,
                    "+" | "-"
                        | "*"
                        | "/"
                        | "%"
                        | "!"
                        | "&&"
                        | "||"
                        | "=="
                        | "!="
                        | "<"
                        | ">"
                        | "<="
                        | ">="
                        | "?"
                        | ":"
                        | "("
                        | ")"
                        | "["
                        | "]"
                        | "."
                        | ","
                ) {
                    return Err(error(crate::messages::format(
                        "templates.expression.new.unsupported_expression_token_text",
                        &[("TEXT", text.to_string())],
                    )));
                }
                tokens.push(Token {
                    text: text.into(),
                    literal: None,
                    name: false,
                });
            }
        }
        tokens.push(Token {
            text: String::new(),
            literal: None,
            name: false,
        });
        Ok(Self {
            tokens,
            cursor: 0,
            depth: 0,
        })
    }
    fn peek(&self) -> &str {
        &self.tokens[self.cursor].text
    }
    fn take(&mut self, text: &str) -> bool {
        if self.peek() == text {
            self.cursor += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, text: &str) -> Result<()> {
        if !self.take(text) {
            return Err(error(crate::messages::format(
                "templates.expression.expect.expected_text_found_arg1",
                &[
                    ("TEXT", text.to_string()),
                    ("ARG1", self.peek().to_string()),
                ],
            )));
        }
        Ok(())
    }
    pub(super) fn parse(mut self) -> Result<Expr> {
        let (node, _) = self.expr(0)?;
        self.expect("")?;
        Ok(node)
    }
    fn expr(&mut self, minimum: u8) -> Result<(Expr, usize)> {
        self.depth += 1;
        if self.depth > 128 {
            return Err(error(crate::messages::text(
                "templates.expression.expr.expression_nesting_exceeds_the_limit",
            )));
        }
        let (mut node, mut tree_depth) = if matches!(self.peek(), "+" | "-" | "!") {
            let op = self.peek().to_owned();
            self.cursor += 1;
            let (value, depth) = self.expr(8)?;
            (Expr::Unary(op, Box::new(value)), depth + 1)
        } else if self.take("(") {
            let node = self.expr(0)?;
            self.expect(")")?;
            node
        } else if self.take("[") {
            let mut values = Vec::new();
            let mut depth = 1;
            if self.peek() != "]" {
                loop {
                    let (value, value_depth) = self.expr(0)?;
                    depth = depth.max(value_depth + 1);
                    values.push(value);
                    if !self.take(",") {
                        break;
                    }
                    if self.peek() == "]" {
                        return Err(error(crate::messages::text(
                            "templates.expression.expr.an_expression_list_cannot_end_with_a",
                        )));
                    }
                }
            }
            self.expect("]")?;
            (Expr::Array(values), depth)
        } else {
            let token = self.tokens[self.cursor].clone();
            if let Some(value) = token.literal {
                self.cursor += 1;
                (Expr::Literal(value), 1)
            } else if token.name {
                self.cursor += 1;
                let value = match token.text.as_str() {
                    "true" => Expr::Literal(Value::Bool(true)),
                    "false" => Expr::Literal(Value::Bool(false)),
                    "null" => Expr::Literal(Value::Null),
                    _ => Expr::Name(token.text),
                };
                (value, 1)
            } else {
                return Err(error(crate::messages::format(
                    "templates.expression.expr.expected_an_expression_found_arg0",
                    &[("ARG0", token.text.to_string())],
                )));
            }
        };
        loop {
            if tree_depth > 128 {
                return Err(error(crate::messages::text(
                    "templates.expression.expr.expression_nesting_exceeds_the_limit",
                )));
            }
            if self.take(".") {
                let token = self.tokens[self.cursor].clone();
                if !token.name {
                    return Err(error(crate::messages::text(
                        "templates.expression.expr.expected_a_member_name_after",
                    )));
                }
                self.cursor += 1;
                node = Expr::Member(
                    Box::new(node),
                    Box::new(Expr::Literal(Value::String(token.text))),
                );
                tree_depth += 1;
                continue;
            }
            if self.take("[") {
                let (member, depth) = self.expr(0)?;
                self.expect("]")?;
                node = Expr::Member(Box::new(node), Box::new(member));
                tree_depth = tree_depth.max(depth) + 1;
                continue;
            }
            if self.peek() == "(" {
                let Expr::Name(name) = node else {
                    break;
                };
                self.cursor += 1;
                let mut args = Vec::new();
                if self.peek() != ")" {
                    loop {
                        let (arg, depth) = self.expr(0)?;
                        tree_depth = tree_depth.max(depth + 1);
                        args.push(arg);
                        if !self.take(",") {
                            break;
                        }
                    }
                }
                self.expect(")")?;
                if !helper_name(&name) {
                    return Err(error(crate::messages::format(
                        "templates.expression.expr.unknown_expression_helper_name",
                        &[("NAME", name.to_string())],
                    )));
                }
                node = Expr::Call(name, args);
                continue;
            }
            let precedence = match self.peek() {
                "||" => 1,
                "&&" => 2,
                "==" | "!=" => 3,
                "<" | "<=" | ">" | ">=" => 4,
                "+" | "-" => 5,
                "*" | "/" | "%" => 6,
                _ => 0,
            };
            if precedence == 0 || precedence < minimum {
                break;
            }
            let op = self.peek().to_owned();
            self.cursor += 1;
            let (right, depth) = self.expr(precedence + 1)?;
            node = Expr::Binary(op, Box::new(node), Box::new(right));
            tree_depth = tree_depth.max(depth) + 1;
        }
        if minimum == 0 && self.take("?") {
            let (yes, yes_depth) = self.expr(0)?;
            self.expect(":")?;
            let (no, no_depth) = self.expr(0)?;
            node = Expr::Conditional(Box::new(node), Box::new(yes), Box::new(no));
            tree_depth = tree_depth.max(yes_depth).max(no_depth) + 1;
        }
        if tree_depth > 128 {
            return Err(error(crate::messages::text(
                "templates.expression.expr.expression_nesting_exceeds_the_limit",
            )));
        }
        self.depth -= 1;
        Ok((node, tree_depth))
    }
}
