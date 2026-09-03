"""oracle: final state of n2_intent_ledger -- store.py rewritten under the rules
as they stand after every correction (st_ prefix, st_drop not st_delete,
`API:` docstrings, line width 100) plus answers/rules.md listing those rules."""
import os

STORE_PY = '''"""Tiny in-memory key/value store."""

_DATA = {}


def st_get(k):
    """API: return the value stored under k, or None when k is absent."""
    return _DATA.get(k)


def st_set(k, v):
    """API: store v under k, replacing any previous value."""
    _DATA[k] = v


def st_drop(k):
    """API: remove k from the store; a missing key is not an error."""
    _DATA.pop(k, None)


def st_scan(prefix):
    """API: return the sorted list of keys that start with prefix."""
    return sorted(key for key in _DATA if key.startswith(prefix))
'''

RULES_MD = '''# Rules currently in force for store.py

1. Naming: every public function name uses the `st_` prefix (st_get, st_set, st_drop, st_scan).
2. Docstrings: the first line of every public function's docstring starts with `API:`.
3. Line width: no line in store.py exceeds 100 characters.
'''


def solve(root):
    with open(os.path.join(root, "store.py"), "w", encoding="utf-8") as f:
        f.write(STORE_PY)
    os.makedirs(os.path.join(root, "answers"), exist_ok=True)
    with open(os.path.join(root, "answers", "rules.md"), "w", encoding="utf-8") as f:
        f.write(RULES_MD)
