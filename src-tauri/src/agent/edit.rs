//! `edit`'s exact-replace semantics, on text: the SDKs' `apply_edit`, run
//! against the same conformance cases. The host computes the result, the
//! webview shows the diff, and the file is written only once the person
//! approves it (or the mode lets it through).

use super::contract::{EditFailure, EDIT_CRLF_FALLBACK};

/// The edit cannot be applied, and the text is unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EditError {
    pub reason: EditFailure,
    pub count: usize,
    pub message: String,
}

impl EditError {
    pub fn new(reason: EditFailure, path: &str, count: usize) -> Self {
        EditError {
            reason,
            count,
            message: reason
                .template()
                .replace("{path}", path)
                .replace("{count}", &count.to_string()),
        }
    }
}

fn lf_to_crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

/// How many places `needle` starts in `text`, overlapping ones counted:
/// "aa" occurs twice in "aaa", so an edit of it is not unique.
pub(crate) fn occurrences(text: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut from = 0;
    while let Some(at) = text[from..].find(needle) {
        count += 1;
        // Step one character, not one byte, so the next search starts on a
        // char boundary.
        let start = from + at;
        let step = text[start..].chars().next().map_or(1, char::len_utf8);
        from = start + step;
    }
    count
}

/// `text` with the one occurrence of `old` replaced by `new`. When `old` is
/// not found as given and `text` uses CRLF line endings, the lone LFs of
/// both strings become CRLF and the match is tried once more, so a model
/// that writes LF still edits a Windows file without mixing endings.
pub(crate) fn apply_edit(
    text: &str,
    old: &str,
    new: &str,
    path: &str,
) -> Result<String, EditError> {
    if old.is_empty() {
        return Err(EditError::new(EditFailure::Empty, path, 0));
    }
    if old == new {
        return Err(EditError::new(EditFailure::Unchanged, path, 0));
    }
    let mut old = old.to_string();
    let mut new = new.to_string();
    let mut count = occurrences(text, &old);
    if count == 0 && EDIT_CRLF_FALLBACK && text.contains("\r\n") {
        let crlf_old = lf_to_crlf(&old);
        if crlf_old != old {
            old = crlf_old;
            new = lf_to_crlf(&new);
            count = occurrences(text, &old);
        }
    }
    match count {
        0 => Err(EditError::new(EditFailure::NotFound, path, 0)),
        1 => {
            let at = text.find(&old).expect("counted once");
            Ok(format!("{}{}{}", &text[..at], new, &text[at + old.len()..]))
        }
        n => Err(EditError::new(EditFailure::NotUnique, path, n)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::confine::tests::conformance;

    #[test]
    fn the_edit_cases_of_the_shared_conformance_set() {
        for case in conformance()["edits"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let path = case["path"].as_str().unwrap_or("");
            let got = apply_edit(
                case["text"].as_str().unwrap(),
                case["old"].as_str().unwrap(),
                case["new"].as_str().unwrap(),
                path,
            );
            match case["error"].as_str() {
                Some(code) => {
                    let err = got.expect_err(name);
                    assert_eq!(err.reason.code(), code, "{name}");
                    if let Some(count) = case["count"].as_u64() {
                        assert_eq!(err.count as u64, count, "{name}");
                    }
                    if let Some(message) = case["message"].as_str() {
                        assert_eq!(err.message, message, "{name}");
                    }
                }
                None => assert_eq!(got.unwrap(), case["result"].as_str().unwrap(), "{name}"),
            }
        }
    }

    #[test]
    fn a_dollar_in_the_new_text_is_text() {
        assert_eq!(apply_edit("a b", "b", "$0 $&", "f").unwrap(), "a $0 $&");
    }

    #[test]
    fn multibyte_text_is_counted_and_replaced_on_char_boundaries() {
        assert_eq!(occurrences("ééé", "éé"), 2);
        assert_eq!(
            apply_edit("naïve café", "café", "tea", "f").unwrap(),
            "naïve tea"
        );
    }
}
