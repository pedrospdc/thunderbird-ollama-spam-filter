"""Tests for the classify response parsing logic from background.js.

Run with: python3 test/test_parse_response.py
"""

import re
import unittest


def parse_classify_response(raw_response: str) -> dict:
    """Mirrors the parsing logic in classifyViaGenerate()."""
    output = re.sub(r"<think>[\s\S]*?</think>", "", raw_response).strip()

    last0 = output.rfind("0")
    last1 = output.rfind("1")

    if last0 == -1 and last1 == -1:
        raise ValueError(f'Unexpected classify response: "{raw_response}"')

    is_spam = last1 > last0
    return {"spam": is_spam}


class TestParseClassifyResponse(unittest.TestCase):
    # Real model outputs from user logs — think says spam but output is 0
    def test_think_says_spam_output_0(self):
        r = parse_classify_response(
            '<think>The message "PMZYZ8-9W2V" looks like an automated bot '
            "message with no human content. Classifying as spam.</think>\n\n0"
        )
        self.assertFalse(r["spam"])

    def test_think_says_spam_content_output_0(self):
        r = parse_classify_response(
            "<think>The message appears to be a summary of a news article "
            "with links, which is typical of spam content.</think>\n\n0"
        )
        self.assertFalse(r["spam"])

    def test_think_says_spam_content_output_1(self):
        r = parse_classify_response(
            "<think>The message appears to be a summary of a transaction "
            "link, which is typical of spam content.</think>\n\n1"
        )
        self.assertTrue(r["spam"])

    def test_think_says_not_spam_output_1(self):
        r = parse_classify_response(
            '<think>The message "Er is een pakket naar je onderweg" translates '
            'to "There is a package sent to you on your way.". This message '
            "conveys a legitimate reminder about a package, which is not "
            "indicative of spam, so I will respond with 1.</think>\n\n1"
        )
        self.assertTrue(r["spam"])

    def test_think_mentions_respond_with_0_output_0(self):
        r = parse_classify_response(
            "<think>The message appears to be a styled text message with no "
            "other content, which is likely spam, so I will respond with "
            "0.</think>\n\n0"
        )
        self.assertFalse(r["spam"])

    # Plain outputs without think tags
    def test_bare_0(self):
        self.assertFalse(parse_classify_response("0")["spam"])

    def test_bare_1(self):
        self.assertTrue(parse_classify_response("1")["spam"])

    def test_0_with_whitespace(self):
        self.assertFalse(parse_classify_response("  0\n")["spam"])

    def test_1_with_whitespace(self):
        self.assertTrue(parse_classify_response("\n1  ")["spam"])

    # Think block contains digits but actual output differs
    def test_think_contains_1_output_0(self):
        r = parse_classify_response(
            "<think>I will respond with 1 because it looks suspicious."
            "</think>\n\n0"
        )
        self.assertFalse(r["spam"])

    def test_think_contains_0_output_1(self):
        r = parse_classify_response(
            "<think>This is not spam so I would say 0 but actually it is."
            "</think>\n\n1"
        )
        self.assertTrue(r["spam"])

    # Multiple think blocks
    def test_multiple_think_blocks_output_0(self):
        r = parse_classify_response(
            "<think>First thought.</think>"
            "<think>Second thought with 1.</think>\n\n0"
        )
        self.assertFalse(r["spam"])

    # Should throw on empty / no digit
    def test_empty_after_think_throws(self):
        with self.assertRaises(ValueError):
            parse_classify_response("<think>Some reasoning.</think>")

    def test_no_digits_throws(self):
        with self.assertRaises(ValueError):
            parse_classify_response("ham")

    def test_only_text_no_digits_throws(self):
        with self.assertRaises(ValueError):
            parse_classify_response("this is spam")


if __name__ == "__main__":
    unittest.main()
