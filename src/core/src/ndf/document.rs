use super::{
    BlockKind,
    operation::Selector,
    parser::scan,
    read::{ambiguous, missing, selector},
};
use crate::Result;
use serde_json::Value;
use std::{borrow::Cow, collections::HashMap};

pub struct Node<'a> {
    pub prefix: Cow<'a, str>,
    pub text: Cow<'a, str>,
    pub name: Option<String>,
    pub type_name: String,
    pub kind: BlockKind,
    pub active: bool,
}
pub struct Document<'a> {
    nodes: Vec<Node<'a>>,
    order: Vec<usize>,
    names: HashMap<String, Vec<usize>>,
    tail: &'a str,
}
impl<'a> Document<'a> {
    pub fn new(source: &'a str) -> Result<Self> {
        let blocks = scan(source)?;
        let mut nodes = Vec::with_capacity(blocks.len());
        let mut order = Vec::with_capacity(blocks.len());
        let mut names: HashMap<String, Vec<usize>> = HashMap::new();
        let mut cursor = 0;
        for block in blocks {
            let id = nodes.len();
            if let Some(name) = block.name {
                names.entry(name.into()).or_default().push(id);
            }
            nodes.push(Node {
                prefix: Cow::Borrowed(&source[cursor..block.span.start]),
                text: Cow::Borrowed(&source[block.span.clone()]),
                name: block.name.map(str::to_owned),
                type_name: block.type_name.into(),
                kind: block.kind,
                active: true,
            });
            order.push(id);
            cursor = block.span.end;
        }
        Ok(Self {
            nodes,
            order,
            names,
            tail: &source[cursor..],
        })
    }
    pub fn ids(&self) -> impl Iterator<Item = usize> + '_ {
        self.order
            .iter()
            .copied()
            .filter(|id| self.nodes[*id].active)
    }
    pub fn object_ids(&self) -> impl Iterator<Item = usize> + '_ {
        self.ids()
            .filter(|id| self.nodes[*id].kind == BlockKind::Object)
    }
    pub fn node(&self, id: usize) -> &Node<'a> {
        &self.nodes[id]
    }
    pub fn named(&self, name: &str) -> Result<usize> {
        let values = self.names.get(name).map(Vec::as_slice).unwrap_or(&[]);
        match values {
            [id] if self.nodes[*id].active => Ok(*id),
            [] => Err(missing(crate::messages::format(
                "ndf.document.named.block_name_was_not_found",
                &[("NAME", name.to_string())],
            ))),
            _ => Err(ambiguous(crate::messages::format(
                "ndf.document.named.several_blocks_use_the_name_name",
                &[("NAME", name.to_string())],
            ))),
        }
    }
    pub fn reference(&self, reference: &str) -> Result<usize> {
        if let Some(type_name) = reference.strip_prefix("@type:") {
            let found: Vec<_> = self
                .object_ids()
                .filter(|id| self.nodes[*id].type_name == type_name)
                .collect();
            return match found.as_slice() {
                [id] => Ok(*id),
                [] => Err(missing(crate::messages::format(
                    "ndf.document.reference.type_type_name_was_not_found",
                    &[("TYPE_NAME", type_name.to_string())],
                ))),
                _ => Err(ambiguous(crate::messages::format(
                    "ndf.document.reference.type_type_name_matches_several_blocks",
                    &[("TYPE_NAME", type_name.to_string())],
                ))),
            };
        }
        if let Some(index) = reference
            .strip_prefix('@')
            .and_then(|s| s.parse::<usize>().ok())
        {
            return self.object_ids().nth(index).ok_or_else(|| {
                missing(crate::messages::format(
                    "ndf.document.reference.block_index_index_was_not_found",
                    &[("INDEX", format!("{}", index))],
                ))
            });
        }
        self.named(reference)
    }
    pub fn select(&self, selector_value: &Selector) -> Result<usize> {
        match selector_value.by.as_str() {
            "name" => self.named(
                selector_value
                    .value
                    .as_ref()
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ),
            "index" => {
                let index = selector_value
                    .value
                    .as_ref()
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        missing(crate::messages::text(
                            "ndf.document.select.block_index_is_out_of_range",
                        ))
                    })?;
                self.object_ids().nth(index as usize).ok_or_else(|| {
                    missing(crate::messages::text(
                        "ndf.document.select.block_index_was_not_found",
                    ))
                })
            }
            "match" => {
                let mut found = Vec::new();
                for id in self.object_ids() {
                    let node = &self.nodes[id];
                    let fields = super::read::direct_fields(&node.text)?;
                    let matches =
                        selector_value
                            .r#where
                            .as_ref()
                            .unwrap()
                            .iter()
                            .all(|(key, value)| {
                                fields
                                    .iter()
                                    .find(|field| field.name == key)
                                    .is_some_and(|field| {
                                        super::values::format_value(value).ok().is_some_and(
                                            |expected| {
                                                node.text[field.value.clone()].trim() == expected
                                            },
                                        )
                                    })
                            });
                    if matches {
                        found.push(id);
                    }
                }
                match found.as_slice() {
                    [id] => Ok(*id),
                    [] => Err(missing(crate::messages::text(
                        "ndf.document.select.no_object_matches_the_selector",
                    ))),
                    _ => Err(ambiguous(crate::messages::text(
                        "ndf.document.select.several_objects_match_the_selector",
                    ))),
                }
            }
            _ => Err(selector(crate::messages::text(
                "ndf.document.select.unsupported_object_selector",
            ))),
        }
    }
    pub fn replace(&mut self, id: usize, text: String) -> Result<()> {
        let blocks = scan(&text)?;
        let old_name = self.nodes[id].name.clone();
        let next = blocks.first();
        if blocks.len() > 1 {
            return Err(selector(crate::messages::text(
                "ndf.document.replace.a_block_edit_produced_several_top_level",
            )));
        }
        let next_name = next.and_then(|b| b.name).map(str::to_owned);
        if old_name != next_name {
            if let Some(name) = &old_name
                && let Some(ids) = self.names.get_mut(name)
            {
                ids.retain(|candidate| *candidate != id);
                if ids.is_empty() {
                    self.names.remove(name);
                }
            }
            if let Some(name) = &next_name {
                self.names.entry(name.clone()).or_default().push(id);
            }
        }
        let node = &mut self.nodes[id];
        node.active = next.is_some();
        node.name = next_name;
        if let Some(next) = next {
            node.kind = next.kind;
            node.type_name = next.type_name.into();
        }
        node.text = Cow::Owned(text);
        Ok(())
    }
    pub fn insert(&mut self, text: String, position: usize) -> Result<usize> {
        let blocks = scan(&text)?;
        if blocks.is_empty() {
            return Err(selector(crate::messages::text(
                "ndf.document.insert.a_top_level_addition_must_contain_a",
            )));
        }
        let first = self.nodes.len();
        let mut cursor = 0;
        for (index, block) in blocks.iter().enumerate() {
            let id = self.nodes.len();
            let name = block.name.map(str::to_owned);
            if let Some(name) = &name {
                self.names.entry(name.clone()).or_default().push(id);
            }
            let prefix = if index == 0 {
                Cow::Borrowed(
                    "

",
                )
            } else {
                Cow::Owned(text[cursor..block.span.start].to_owned())
            };
            let start = if index == 0 { 0 } else { block.span.start };
            let end = if index + 1 == blocks.len() {
                text.len()
            } else {
                block.span.end
            };
            self.nodes.push(Node {
                prefix,
                text: Cow::Owned(text[start..end].to_owned()),
                name,
                type_name: block.type_name.into(),
                kind: block.kind,
                active: true,
            });
            self.order
                .insert((position + index).min(self.order.len()), id);
            cursor = block.span.end;
        }
        Ok(first)
    }
    pub fn position(&self, id: usize) -> usize {
        self.order
            .iter()
            .position(|candidate| *candidate == id)
            .unwrap()
    }
    pub fn order_len(&self) -> usize {
        self.order.len()
    }
    pub fn render(&self) -> String {
        let length = self.tail.len()
            + self
                .order
                .iter()
                .map(|id| {
                    let node = &self.nodes[*id];
                    node.prefix.len() + node.text.len()
                })
                .sum::<usize>();
        let mut output = String::with_capacity(length);
        for id in &self.order {
            let node = &self.nodes[*id];
            output.push_str(&node.prefix);
            output.push_str(&node.text);
        }
        output.push_str(self.tail);
        output
    }
}
