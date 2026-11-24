use super::lexer::{Kind, Lexer, Token, error};
use crate::Result;
use std::ops::Range;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockKind {
    Object,
    Template,
    Bare,
}

#[derive(Clone, Debug)]
pub struct Block<'a> {
    pub name: Option<&'a str>,
    pub type_name: &'a str,
    pub span: Range<usize>,
    pub body: Option<Range<usize>>,
    pub kind: BlockKind,
}

#[derive(Clone, Debug)]
pub struct Field<'a> {
    pub name: &'a str,
    pub span: Range<usize>,
    pub value: Range<usize>,
}
#[derive(Clone, Default)]
struct Expression<'a> {
    declared: bool,
    name: Option<&'a str>,
    type_name: &'a str,
    body: Option<Range<usize>>,
}

pub struct Parser<'a> {
    pub lexer: Lexer<'a>,
    pub token: Token<'a>,
    pub previous_end: usize,
    depth: usize,
    objects: Option<Vec<Block<'a>>>,
    fields: Option<Vec<Field<'a>>>,
}

impl<'a> Parser<'a> {
    pub fn new(source: &'a str, from: usize) -> Result<Self> {
        let mut lexer = Lexer::new(source, from);
        let token = lexer.next_token()?;
        Ok(Self {
            lexer,
            token,
            previous_end: from,
            depth: 0,
            objects: None,
            fields: None,
        })
    }
    pub fn source(&self) -> &'a str {
        self.lexer.source
    }
    pub fn advance(&mut self) -> Result<Token<'a>> {
        let old = self.token;
        self.previous_end = old.end;
        self.token = self.lexer.next_token()?;
        Ok(old)
    }
    pub fn take(&mut self, text: &str) -> Result<bool> {
        if self.token.text == text {
            self.advance()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub fn expect(&mut self, text: &str, suggestion: &str) -> Result<()> {
        if !self.take(text)? {
            return Err(error(
                self.source(),
                self.token.start,
                "E14",
                &crate::messages::format(
                    "ndf.parser.expect.expected_text",
                    &[("TEXT", text.to_string())],
                ),
                suggestion,
            ));
        }
        Ok(())
    }
    pub fn identifier(&mut self) -> Result<Token<'a>> {
        if self.token.kind != Kind::Word {
            return Err(error(
                self.source(),
                self.token.start,
                "E14",
                crate::messages::text("ndf.parser.identifier.expected_an_ndf_name"),
                crate::messages::text(
                    "ndf.parser.identifier.supply_a_member_declaration_or_parameter_name",
                ),
            ));
        }
        self.advance()
    }
    fn enter(&mut self) -> Result<()> {
        self.depth += 1;
        if self.depth > 256 {
            return Err(error(
                self.source(),
                self.token.start,
                "E14",
                crate::messages::text("ndf.parser.enter.ndf_expressions_are_nested_too_deeply"),
                crate::messages::text(
                    "ndf.parser.enter.split_deeply_nested_expressions_into_named_definitions",
                ),
            ));
        }
        Ok(())
    }
    pub fn document(&mut self, collect: bool) -> Result<Vec<Block<'a>>> {
        let mut blocks = Vec::new();
        let mut first = true;
        while self.token.kind != Kind::Eof {
            let start = self.token.start;
            while modifier(self.token.text) {
                self.advance()?;
            }
            let (value, kind) = if self.take("template")? {
                let name = self.identifier()?.text;
                self.expect("[", "Open the template parameter list with [.")?;
                while self.token.text != "]" {
                    self.identifier()?;
                    if self.take(":")? {
                        self.type_value()?;
                    }
                    if self.take("=")? {
                        self.expression()?;
                    }
                    if !self.separator("]")? {
                        break;
                    }
                }
                self.expect("]", "Close the template parameter list.")?;
                self.expect("is", "Put is between the template parameters and its body.")?;
                let mut value = self.expression()?;
                value.name = Some(name);
                value.declared = true;
                (value, BlockKind::Template)
            } else if self.take("unnamed")? {
                let mut value = self.expression()?;
                value.declared = true;
                (value, BlockKind::Object)
            } else {
                let value = self.expression()?;
                let kind = if value.body.is_some() {
                    BlockKind::Object
                } else {
                    BlockKind::Bare
                };
                (value, kind)
            };
            if !value.declared && (!first || self.token.kind != Kind::Eof) {
                return Err(error(
                    self.source(),
                    self.token.start,
                    "E14",
                    crate::messages::text("ndf.parser.document.expected_a_named_ndf_declaration"),
                    crate::messages::text("ndf.parser.document.write_name_is_value_for_each_top"),
                ));
            }
            if collect {
                blocks.push(Block {
                    name: value.name,
                    type_name: value.type_name,
                    span: start..self.previous_end,
                    body: value.body,
                    kind,
                });
            }
            first = false;
        }
        Ok(blocks)
    }
    pub fn member(&mut self) -> Result<(Token<'a>, Option<Range<usize>>)> {
        let declaration_start = self.token.start;
        while modifier(self.token.text) {
            self.advance()?;
        }
        let name = self.identifier()?;
        let typed = self.take(":")?;
        if typed {
            self.type_value()?;
        }
        let declaration = if self.take("=")? {
            false
        } else if self.take("is")? {
            true
        } else {
            if typed {
                return Ok((name, None));
            }
            return Err(error(
                self.source(),
                self.token.start,
                "E14",
                crate::messages::text("ndf.parser.member.expected_for_a_member_or_is_for"),
                crate::messages::text("ndf.parser.member.write_member_value_or_name_is_type"),
            ));
        };
        let start = self.token.start;
        let value = self.expression()?;
        if declaration {
            self.name_object(&value, declaration_start, name.text);
        }
        if !declaration && let Some(fields) = &mut self.fields {
            fields.push(Field {
                name: name.text,
                span: name.start..self.previous_end,
                value: start..self.previous_end,
            });
        }
        Ok((name, Some(start..self.previous_end)))
    }
    fn type_value(&mut self) -> Result<()> {
        self.enter()?;
        self.identifier()?;
        if self.take("<")? {
            self.type_value()?;
            while self.take(",")? {
                self.type_value()?;
            }
            self.expect(">", "Close the type parameters with >.")?;
        }
        if self.take("[")? {
            while self.token.text != "]" {
                if matches!(self.token.text, "<" | ">" | "<=" | ">=" | "==" | "!=") {
                    self.advance()?;
                    self.expression()?;
                } else {
                    self.identifier()?;
                    if self.take("=")? {
                        self.expression()?;
                    }
                }
                if !self.separator("]")? {
                    break;
                }
            }
            self.expect("]", "Close the type attributes with ].")?;
        }
        self.depth -= 1;
        Ok(())
    }
    fn expression(&mut self) -> Result<Expression<'a>> {
        self.enter()?;
        let value = self.atom()?;
        while operator(self.token.text) {
            self.advance()?;
            self.atom()?;
        }
        if self.take("?")? {
            self.expression()?;
            self.expect(":", "Separate conditional values with :.")?;
            self.expression()?;
        }
        self.depth -= 1;
        Ok(value)
    }
    pub fn value_end(&mut self) -> Result<usize> {
        self.expression()?;
        Ok(self.previous_end)
    }
    fn atom(&mut self) -> Result<Expression<'a>> {
        while matches!(self.token.text, "+" | "-" | "!") {
            self.advance()?;
        }
        let object_start = self.token.start;
        let mut value = Expression::default();
        if self.take("<")? {
            self.identifier()?;
            self.expect(">", "Close the template parameter reference with >.")?;
        } else if self.token.kind == Kind::Literal {
            self.advance()?;
        } else if self.token.kind == Kind::Word {
            while modifier(self.token.text) {
                self.advance()?;
            }
            let word = self.identifier()?.text;
            if self.take("is")? {
                value = self.expression()?;
                self.name_object(&value, object_start, word);
                value.name = Some(word);
                value.declared = true;
                return Ok(value);
            }
            value.type_name = word;
            if self.take("meta")? {
                self.expect("(", "Open metadata with (.")?;
                while self.token.text != ")" {
                    self.member()?;
                    if !self.separator(")")? {
                        break;
                    }
                }
                self.expect(")", "Close metadata with ).")?;
                if self.token.text != "(" {
                    self.expect("(", "Put the object body after its metadata.")?;
                }
            }
            if self.token.text == "(" {
                let start = self.advance()?.start;
                while self.token.text != ")" {
                    if matches!(self.token.text, "" | "]" | "}") {
                        self.expect(")", "Close the object before closing its collection.")?;
                    }
                    self.member()?;
                }
                let end = self.advance()?.end;
                value.body = Some(start..end);
                if let Some(objects) = &mut self.objects {
                    objects.push(Block {
                        name: None,
                        type_name: word,
                        span: object_start..end,
                        body: value.body.clone(),
                        kind: BlockKind::Object,
                    });
                }
            }
        } else if self.take("[")? {
            self.collection("]")?;
        } else if self.take("(")? {
            self.expression()?;
            if self.take(",")? {
                self.expression()?;
            }
            self.expect(")", "Close the expression or pair with ).")?;
        } else {
            return Err(error(
                self.source(),
                self.token.start,
                "E14",
                crate::messages::text("ndf.parser.atom.expected_an_ndf_value"),
                crate::messages::text("ndf.parser.atom.supply_a_number_string_reference_object_or"),
            ));
        }
        while matches!(self.token.text, "[" | ".") {
            if self.take(".")? {
                self.identifier()?;
            } else {
                self.advance()?;
                self.collection("]")?;
            }
        }
        Ok(value)
    }
    fn name_object(&mut self, value: &Expression<'a>, start: usize, name: &'a str) {
        if let Some(body) = &value.body
            && let Some(objects) = &mut self.objects
            && let Some(block) = objects
                .iter_mut()
                .rev()
                .find(|block| block.body.as_ref() == Some(body))
        {
            block.name = Some(name);
            block.span.start = start;
        }
    }
    fn collection(&mut self, close: &str) -> Result<()> {
        while self.token.text != close {
            self.expression()?;
            if !self.separator(close)? {
                break;
            }
        }
        self.expect(close, "Close the collection with the matching delimiter.")
    }
    fn separator(&mut self, close: &str) -> Result<bool> {
        if self.token.text == close {
            return Ok(false);
        }
        self.expect(
            ",",
            "Separate collection entries with a comma; one trailing comma is allowed.",
        )?;
        Ok(true)
    }
}

pub fn modifier(text: &str) -> bool {
    matches!(text, "export" | "private" | "public")
}
fn operator(text: &str) -> bool {
    matches!(
        text,
        "+" | "-"
            | "*"
            | "/"
            | "%"
            | "&"
            | "|"
            | "^"
            | "=="
            | "!="
            | "<"
            | ">"
            | "<="
            | ">="
            | "div"
            | "mod"
            | "and"
            | "or"
            | "xor"
            | "in"
    )
}

pub fn validate(source: &str) -> Result<()> {
    Parser::new(source, 0)?.document(false).map(|_| ())
}
pub fn scan(source: &str) -> Result<Vec<Block<'_>>> {
    Parser::new(source, 0)?.document(true)
}

pub fn fields(source: &str) -> Result<Vec<Field<'_>>> {
    let mut parser = Parser::new(source, 0)?;
    parser.fields = Some(Vec::new());
    parser.document(false)?;
    let mut fields = parser.fields.take().unwrap();
    fields.sort_unstable_by_key(|field| field.span.start);
    Ok(fields)
}
pub fn objects(source: &str) -> Result<Vec<Block<'_>>> {
    let mut parser = Parser::new(source, 0)?;
    parser.objects = Some(Vec::new());
    let top: std::collections::HashMap<_, _> = parser
        .document(true)?
        .into_iter()
        .filter_map(|block| {
            let start = block.body.as_ref()?.start;
            Some((start, block))
        })
        .collect();
    let mut objects = parser.objects.take().unwrap();
    objects.retain_mut(|block| {
        if let Some(top) = block.body.as_ref().and_then(|body| top.get(&body.start)) {
            if top.kind != BlockKind::Object {
                return false;
            }
            *block = top.clone();
        }
        true
    });
    objects.sort_by_key(|block| block.span.start);
    Ok(objects)
}
