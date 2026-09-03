"""oracle: fix parse_amount (parentheses negatives), add clamp_percent and its tests."""
import os

CALC = '''"""Small money/number helpers used by the reporting scripts."""
import math


def parse_amount(text):
    """Parse a money string into a float.

    Accepts an optional leading '$', thousands separators (',') and
    accounting-style negatives written in parentheses: "(1,234.50)" -> -1234.5.
    A leading '-' also works: "-12" -> -12.0. Surrounding whitespace is ignored.
    """
    s = text.strip().replace("$", "").replace(",", "")
    negative = s.startswith("(") and s.endswith(")")
    if negative:
        s = s[1:-1].strip()
    value = float(s)
    return -value if negative else value


def percent_change(old, new):
    """Percentage change from old to new: 50 -> 75 is 50.0.

    old must be non-zero; a ZeroDivisionError propagates otherwise.
    """
    return (new - old) / old * 100.0


def round_half_up(x):
    """Round to the nearest integer; ties (.5) go toward positive infinity,
    so 2.5 -> 3 and -2.5 -> -2 (unlike Python's banker's rounding)."""
    return math.floor(x + 0.5)


def mean(values):
    """Arithmetic mean of a non-empty sequence; ValueError when empty."""
    values = list(values)
    if not values:
        raise ValueError("mean of empty sequence")
    return sum(values) / len(values)


def clamp_percent(value):
    """Limit value to the range [0, 100]."""
    if value < 0:
        return 0
    if value > 100:
        return 100
    return value
'''

TEST_CLAMP = '''from calc import clamp_percent


def test_clamp_below_range():
    assert clamp_percent(-5) == 0
    assert clamp_percent(-0.5) == 0


def test_clamp_above_range():
    assert clamp_percent(150) == 100
    assert clamp_percent(100.5) == 100


def test_clamp_inside_range():
    assert clamp_percent(42) == 42
    assert clamp_percent(0) == 0
    assert clamp_percent(100) == 100
'''


def solve(root):
    with open(os.path.join(root, 'calc.py'), 'w') as f:
        f.write(CALC)
    with open(os.path.join(root, 'tests', 'test_clamp.py'), 'w') as f:
        f.write(TEST_CLAMP)
