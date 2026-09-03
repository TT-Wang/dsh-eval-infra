"""p2_persistent_rule workspace: a three-file package plus tests. Two files
violate the header rule the user is about to state (one has no header, one has a
look-alike header) and two functions are camelCase."""
import os

FILES = {
    'textkit/__init__.py': '''# SPDX-License-Identifier: MIT
"""textkit: small text utilities."""
from .normalize import collapseSpaces, lowercase
from .stats import avgWordLength, char_count
''',
    'textkit/normalize.py': '''"""Whitespace and case normalisation."""
import re


def collapseSpaces(text):
    """Collapse every run of whitespace to a single space."""
    return re.sub(r"\\s+", " ", text)


def lowercase(text):
    """Lower-case the text."""
    return text.lower()
''',
    'textkit/stats.py': '''# License: MIT (see LICENSE file)
"""Simple text statistics."""


def char_count(text):
    """Number of characters in text."""
    return len(text)


def avgWordLength(text):
    """Average length of the whitespace-separated words (0.0 when there are none)."""
    words = text.split()
    if not words:
        return 0.0
    return sum(len(w) for w in words) / len(words)
''',
    'tests/test_textkit.py': '''from textkit import avgWordLength, char_count, collapseSpaces, lowercase


def test_collapse():
    assert collapseSpaces("a   b\\tc") == "a b c"


def test_lowercase():
    assert lowercase("AbC") == "abc"


def test_avg_word_length():
    assert avgWordLength("ab cd") == 2.0
    assert avgWordLength("") == 0.0


def test_char_count():
    assert char_count("abc") == 3
''',
    'README.md': '''# textkit

Small text utilities: `textkit.normalize` (whitespace/case helpers) and `textkit.stats`
(counts and averages). Run the tests with `python3 -m pytest -q tests/`.
''',
}


def setup(root):
    for rel, body in FILES.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(body)
