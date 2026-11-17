pub mod document;
pub mod lexer;
pub mod operation;
pub mod parser;
pub mod patch;
pub mod read;
pub mod values;
pub use parser::{Block, BlockKind, scan, validate};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_neighboring_grammar_cases() {
        for source in [
            "",
            "// comment",
            "A is 1",
            "A is T(X = [1, 2,])",
            "A is MAP[(\"a\", 1), (\"b\", T(X = True))]",
            "template A[x: list<int>, y = 2] is T(Value = <x>)",
            "public A is B is T(X = -1.5e-2)",
            "unnamed T(X = GUID:{1234-abcd})",
            "BaseUnit is T(DescriptorId = GUID:{fg25aaea-9679-4a61-b5ea-c5b0747e6216})",
            "A is T meta(X = 1, Y = 2)(Value = ~/Path/Item)",
        ] {
            assert!(validate(source).is_ok(), "{source}: {:?}", validate(source));
        }
        for (source, code) in [
            ("A is T(X = [1 2])", "E14"),
            ("A is T(X = )", "E14"),
            ("A is T(X = [1,)", "E14"),
            ("A is T(X = 'open)", "E36"),
            ("/* open", "E35"),
            ("1 2", "E14"),
            ("T() T()", "E14"),
            ("A is T(X = 1, Y = 2)", "E14"),
        ] {
            assert_eq!(
                validate(source).unwrap_err().code.as_deref(),
                Some(code),
                "{source}"
            );
        }
    }
    #[test]
    fn scanning_keeps_templates_separate_and_skips_quoted_headers() {
        let source = "// Fake is T()\nexport A is T(X = 'Fake is T()' Y = T(N = 2))\ntemplate P[x] is T(X = <x>)\nValues is [1,2]";
        let blocks = scan(source).unwrap();
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].name, Some("A"));
        assert_eq!(blocks[0].kind, BlockKind::Object);
        assert_eq!(blocks[1].kind, BlockKind::Template);
        assert_eq!(blocks[2].kind, BlockKind::Bare);
        assert_eq!(
            &source[blocks[0].span.clone()],
            "export A is T(X = 'Fake is T()' Y = T(N = 2))"
        );
    }
    #[test]
    fn nesting_is_bounded() {
        let source = format!("A is {}1{}", "[".repeat(300), "]".repeat(300));
        assert_eq!(validate(&source).unwrap_err().code.as_deref(), Some("E14"));
    }
}
