use super::*;

pub(crate) fn resolve_in_budget(
    value: &Value,
    variables: &Value,
    budget: &mut Budget,
) -> Result<Value> {
    let mut resolver = Resolver::new(variables);
    std::mem::swap(&mut resolver.budget, budget);
    let result = resolver.resolve(value);
    std::mem::swap(&mut resolver.budget, budget);
    result
}

pub struct Resolver<'a> {
    variables: &'a Value,
    active: HashSet<Vec<String>>,
    cache: HashMap<Vec<String>, Value>,
    depth: usize,
    evaluation_depth: usize,
    budget: Budget,
}
impl<'a> Resolver<'a> {
    pub fn new(variables: &'a Value) -> Self {
        Self {
            variables,
            active: HashSet::new(),
            cache: HashMap::new(),
            depth: 0,
            evaluation_depth: 0,
            budget: Budget::default(),
        }
    }
    pub fn resolve(&mut self, value: &Value) -> Result<Value> {
        // Host configuration is data; its embedded templates need their own scope.
        if self
            .variables
            .get("config")
            .is_some_and(|config| std::ptr::eq(config, value))
        {
            return self.budget.copy(value);
        }
        if self.depth >= 128 {
            return Err(error(crate::messages::text(
                "templates.resolver.resolve.template_resolution_exceeds_the_nesting_limit",
            )));
        }
        self.depth += 1;
        let result = (|| match value {
            Value::String(text) => self.interpolate(text),
            Value::Array(values) => {
                self.budget.reserve(array_bytes(values.len()))?;
                let mut resolved = Vec::with_capacity(values.len());
                for value in values {
                    resolved.push(self.resolve(value)?);
                }
                Ok(Value::Array(resolved))
            }
            Value::Object(values) => {
                self.budget
                    .reserve(values.keys().fold(map_bytes(values.len()), |n, key| {
                        n.saturating_add(key.len())
                    }))?;
                let mut resolved = Map::with_capacity(values.len());
                for (key, value) in values {
                    resolved.insert(key.clone(), self.resolve(value)?);
                }
                Ok(Value::Object(resolved))
            }
            value => self.budget.copy(value),
        })();
        self.depth -= 1;
        result
    }
    pub fn expression(&mut self, source: &str) -> Result<Value> {
        let source = source.trim();
        if source.len() <= 1_048_576
            && is_name(source)
            && (!matches!(source, "true" | "false" | "null")
                || self.variables.get(source).is_some())
        {
            self.budget.reserve(source.len())?;
            return self.resolve_path(&[source.to_owned()]);
        }
        let ast = Parser::new(source)?.parse()?;
        self.evaluate(&ast)
    }
    fn resolve_path(&mut self, path: &[String]) -> Result<Value> {
        if let Some(value) = self.cache.get(path) {
            return self.budget.copy(value);
        }
        self.budget.reserve(path_bytes(path))?;
        if !self.active.insert(path.to_vec()) {
            return Err(error(crate::messages::format(
                "templates.resolver.resolve_path.circular_template_variable_reference_involving_arg0",
                &[("ARG0", path.join(".").to_string())],
            )));
        }
        let result = (|| {
            if self.active.len() > 128 {
                return Err(error(crate::messages::text(
                    "templates.resolver.resolve_path.template_reference_chain_exceeds_the_nesting_limit",
                )));
            }
            let raw = raw_member(self.variables, path).ok_or_else(|| {
                error(crate::messages::format(
                    "templates.resolver.resolve_path.unknown_template_variable_or_member_arg0",
                    &[("ARG0", path.join(".").to_string())],
                ))
            })?;
            if path.first().is_some_and(|key| key == "config") {
                return self.budget.copy(raw);
            }
            let value = match raw {
                Value::Object(values) => {
                    self.budget.reserve(
                        values.keys().fold(map_bytes(values.len()), |n, key| {
                            n.saturating_add(key.len())
                        }),
                    )?;
                    let mut resolved = Map::with_capacity(values.len());
                    for key in values.keys() {
                        let nested = self.child_path(path, key)?;
                        resolved.insert(key.clone(), self.resolve_path(&nested)?);
                    }
                    Value::Object(resolved)
                }
                Value::Array(values) => {
                    self.budget.reserve(array_bytes(values.len()))?;
                    let mut resolved = Vec::with_capacity(values.len());
                    for index in 0..values.len() {
                        let index = index.to_string();
                        self.budget.reserve(index.len())?;
                        let nested = self.child_path(path, &index)?;
                        resolved.push(self.resolve_path(&nested)?);
                    }
                    Value::Array(resolved)
                }
                _ => self.resolve(raw)?,
            };
            self.budget.reserve(path_bytes(path))?;
            self.cache.insert(path.to_vec(), self.budget.copy(&value)?);
            Ok(value)
        })();
        self.active.remove(path);
        result
    }
    fn child_path(&mut self, path: &[String], key: &str) -> Result<Vec<String>> {
        self.budget.reserve(
            path_bytes(path)
                .saturating_add(std::mem::size_of::<String>())
                .saturating_add(key.len()),
        )?;
        let mut nested = Vec::with_capacity(path.len() + 1);
        nested.extend(path.iter().cloned());
        nested.push(key.to_owned());
        Ok(nested)
    }
    fn interpolate(&mut self, text: &str) -> Result<Value> {
        let mut cursor = 0;
        let mut output = String::new();
        while let Some(relative) = text[cursor..].find("${") {
            let start = cursor + relative;
            self.budget.reserve(start - cursor)?;
            output.push_str(&text[cursor..start]);
            let mut at = start + 2;
            let mut quote = None;
            let mut escaped = false;
            let mut end = None;
            for ch in text[at..].chars() {
                if escaped {
                    escaped = false;
                } else if quote.is_some() && ch == '\\' {
                    escaped = true;
                } else if quote == Some(ch) {
                    quote = None;
                } else if quote.is_none() && matches!(ch, '\'' | '"') {
                    quote = Some(ch);
                } else if quote.is_none() && ch == '}' {
                    end = Some(at);
                    break;
                }
                at += ch.len_utf8();
            }
            let end = end.ok_or_else(|| {
                error(crate::messages::text(
                    "templates.resolver.interpolate.unterminated_template_expression",
                ))
            })?;
            let value = self.expression(&text[start + 2..end])?;
            if start == 0 && end + 1 == text.len() {
                return Ok(value);
            }
            let value = self.budget.stringify(&value)?;
            self.budget.reserve(value.len())?;
            output.push_str(&value);
            cursor = end + 1;
        }
        self.budget.reserve(text.len() - cursor)?;
        output.push_str(&text[cursor..]);
        Ok(Value::String(output))
    }
    fn path_for(&mut self, node: &Expr) -> Result<Option<Vec<String>>> {
        match node {
            Expr::Name(name) if self.variables.get(name).is_some() => {
                self.budget
                    .reserve(path_bytes(std::slice::from_ref(name)))?;
                Ok(Some(vec![name.clone()]))
            }
            Expr::Member(object, property) => {
                if let Some(mut path) = self.path_for(object)? {
                    let key = self.evaluate(property)?;
                    self.budget.reserve(
                        value_bytes(&key)?.saturating_add(2 * std::mem::size_of::<String>()),
                    )?;
                    path.push(member_key(&key)?);
                    if raw_member(self.variables, &path).is_some() {
                        return Ok(Some(path));
                    }
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }
    fn evaluate(&mut self, node: &Expr) -> Result<Value> {
        if self.evaluation_depth >= 128 {
            return Err(error(crate::messages::text(
                "templates.resolver.evaluate.expression_evaluation_exceeds_the_nesting_limit",
            )));
        }
        self.evaluation_depth += 1;
        let result = self.evaluate_inner(node);
        self.evaluation_depth -= 1;
        result
    }
    fn evaluate_inner(&mut self, node: &Expr) -> Result<Value> {
        match node {
            Expr::Literal(value) => self.budget.copy(value),
            Expr::Name(name) => self.resolve_path(std::slice::from_ref(name)),
            Expr::Array(values) => {
                self.budget.reserve(array_bytes(values.len()))?;
                let mut resolved = Vec::with_capacity(values.len());
                for value in values {
                    resolved.push(self.evaluate(value)?);
                }
                Ok(Value::Array(resolved))
            }
            Expr::Unary(op, value) => {
                let value = self.evaluate(value)?;
                match op.as_str() {
                    "!" => Ok(Value::Bool(!truthy(&value))),
                    "+" => number(numeric(&value)?),
                    _ => number(-numeric(&value)?),
                }
            }
            Expr::Binary(op, left, right) => {
                let left = self.evaluate(left)?;
                if (op == "&&" && !truthy(&left)) || (op == "||" && truthy(&left)) {
                    return Ok(left);
                }
                let right = self.evaluate(right)?;
                match op.as_str() {
                    "&&" | "||" => Ok(right),
                    "+" if left.is_string() || right.is_string() => {
                        let left = self.budget.stringify(&left)?;
                        let right = self.budget.stringify(&right)?;
                        self.budget
                            .reserve(left.len().saturating_add(right.len()))?;
                        Ok(Value::String(left + &right))
                    }
                    "+" => number(numeric(&left)? + numeric(&right)?),
                    "-" => number(numeric(&left)? - numeric(&right)?),
                    "*" => number(numeric(&left)? * numeric(&right)?),
                    "/" | "%" => {
                        let a = numeric(&left)?;
                        let b = numeric(&right)?;
                        if b == 0.0 {
                            return Err(error(crate::messages::text(
                                "templates.resolver.evaluate_inner.division_or_remainder_by_zero",
                            )));
                        }
                        number(if op == "/" { a / b } else { a % b })
                    }
                    "==" => Ok(Value::Bool(equal(&left, &right))),
                    "!=" => Ok(Value::Bool(!equal(&left, &right))),
                    _ => {
                        let comparison = compare(&left, &right)?;
                        Ok(Value::Bool(match op.as_str() {
                            "<" => comparison.is_some_and(|v| v.is_lt()),
                            "<=" => comparison.is_some_and(|v| v.is_le()),
                            ">" => comparison.is_some_and(|v| v.is_gt()),
                            _ => comparison.is_some_and(|v| v.is_ge()),
                        }))
                    }
                }
            }
            Expr::Conditional(test, yes, no) => {
                let test = self.evaluate(test)?;
                self.evaluate(if truthy(&test) { yes } else { no })
            }
            Expr::Member(object, property) => {
                if let Some(path) = self.path_for(node)? {
                    return self.resolve_path(&path);
                }
                let object = self.evaluate(object)?;
                let key = self.evaluate(property)?;
                read_member(&object, &key, &mut self.budget)
            }
            Expr::Call(name, args) => {
                self.budget.reserve(array_bytes(args.len()))?;
                let mut values = Vec::with_capacity(args.len());
                for arg in args {
                    values.push(self.evaluate(arg)?);
                }
                helper(name, &values, &mut self.budget)
            }
        }
    }
}
