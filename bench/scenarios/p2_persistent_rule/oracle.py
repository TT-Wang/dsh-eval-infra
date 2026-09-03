"""oracle: the repo as it should look after all four turns."""
import os

H = '# SPDX-License-Identifier: MIT\n'
FILES = {
    'textkit/__init__.py': H + '''"""textkit: small text utilities."""
from .normalize import collapse_spaces, lowercase, strip_punctuation
from .stats import avg_word_length, char_count, char_frequency, word_count
from .tokenize import split_sentences
''',
    'textkit/normalize.py': H + '''"""Whitespace, case and punctuation normalisation."""
import re
import string

_PUNCT = str.maketrans("", "", string.punctuation)


def collapse_spaces(text):
    """Collapse every run of whitespace to a single space and trim the edges."""
    return re.sub(r"\\s+", " ", text).strip()


def lowercase(text):
    """Lower-case the text."""
    return text.lower()


def strip_punctuation(text):
    """Remove every character contained in string.punctuation."""
    return text.translate(_PUNCT)
''',
    'textkit/stats.py': H + '''"""Simple text statistics."""


def char_count(text):
    """Number of characters in text."""
    return len(text)


def avg_word_length(text):
    """Average length of the whitespace-separated words (0.0 when there are none)."""
    words = text.split()
    if not words:
        return 0.0
    return sum(len(w) for w in words) / len(words)


def word_count(text):
    """Number of whitespace-separated words."""
    return len(text.split())


def char_frequency(text):
    """Map each non-whitespace character to the number of times it occurs."""
    freq = {}
    for ch in text:
        if not ch.isspace():
            freq[ch] = freq.get(ch, 0) + 1
    return freq
''',
    'textkit/tokenize.py': H + '''"""Sentence splitting."""
import re

_BOUNDARY = re.compile(r"(?<=[.!?])(?=\\s|$)")


def split_sentences(text):
    """Split at every '.', '!' or '?' followed by whitespace or the end of the text."""
    return [piece.strip() for piece in _BOUNDARY.split(text) if piece.strip()]
''',
    'tests/test_textkit.py': H + '''from textkit import (avg_word_length, char_count, char_frequency, collapse_spaces, lowercase,
                     strip_punctuation, word_count)


def test_collapse():
    assert collapse_spaces("a   b\\tc") == "a b c"


def test_collapse_trims_edges():
    assert collapse_spaces("  a   b \\n c ") == "a b c"


def test_lowercase():
    assert lowercase("AbC") == "abc"


def test_avg_word_length():
    assert avg_word_length("ab cd") == 2.0
    assert avg_word_length("") == 0.0


def test_char_count():
    assert char_count("abc") == 3


def test_word_count():
    assert word_count("a b  c") == 3
    assert word_count("") == 0


def test_char_frequency():
    assert char_frequency("aab c") == {"a": 2, "b": 1, "c": 1}
    assert char_frequency("") == {}


def test_strip_punctuation():
    assert strip_punctuation("Hi, there! (ok)") == "Hi there ok"
''',
    'tests/test_tokenize.py': H + '''from textkit import split_sentences


def test_split_basic():
    assert split_sentences("Hi there. How are you?  Fine!") == ["Hi there.", "How are you?", "Fine!"]


def test_split_inner_dot_and_tail():
    assert split_sentences("v1.2 is out. Yes") == ["v1.2 is out.", "Yes"]


def test_split_empty():
    assert split_sentences("") == []
    assert split_sentences("Wow!!") == ["Wow!!"]
''',
    'CHANGELOG.md': '''# Changelog

- tokenize: add split_sentences and export it from the package
- normalize: add strip_punctuation
- normalize: collapse_spaces now also trims leading and trailing whitespace
- stats: add word_count and char_frequency
- stats: rename avgWordLength to avg_word_length
- normalize: rename collapseSpaces to collapse_spaces
- repo: add the MIT SPDX license header to every Python file
''',
}


def solve(root):
    for rel, body in FILES.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(body)
