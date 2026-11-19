"""Pure functions that read the model's reply: no model, no I/O."""

import json

import pytest

from parsing import extract_partial_json_string, parse_response


def reply(code="print(1)", thinking="Print one", **extra):
    return json.dumps({"thinking": thinking, "code": code, "language": "python", **extra})


def test_valid_reply_becomes_a_code_block():
    block = parse_response(reply())
    assert (block.code, block.explanation, block.language) == ("print(1)", "Print one", "python")
    assert not block.is_done


def test_markdown_fences_are_stripped():
    assert parse_response("```json\n" + reply() + "\n```").code == "print(1)"


def test_done_is_empty_code_with_done_explanation():
    assert parse_response(reply(code="", thinking="DONE")).is_done


@pytest.mark.parametrize("content", [
    "not json",
    "[1, 2]",
    json.dumps({"thinking": "x", "code": 5}),
    reply(code="", thinking="forgot the sentinel"),
])
def test_unusable_replies_raise_value_error(content):
    with pytest.raises(ValueError):
        parse_response(content)


def test_partial_string_stops_at_the_closing_quote_or_an_unfinished_escape():
    text = '{"thinking": "Plot", "code": "import ma'
    assert extract_partial_json_string(text, "code") == "import ma"
    assert extract_partial_json_string(text, "thinking") == "Plot"
    assert extract_partial_json_string(text, "language") is None
    assert extract_partial_json_string(r'{"code": "a\nb' + "\\", "code") == "a\nb"   # lone trailing backslash
    assert extract_partial_json_string(r'{"code": "a\u00', "code") == "a"


def test_partial_string_joins_surrogate_pairs():
    assert extract_partial_json_string(r'{"code": "🐝', "code") == "\U0001f41d"
