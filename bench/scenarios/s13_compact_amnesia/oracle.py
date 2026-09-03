"""oracle: final state after all 16 turns of s13_compact_amnesia.

Turn-1 deploy parameters (given only in chat) go into a TOML file under ops/ (the
standing placement constraint), the blob tokens are read from the data files, the
loglib helpers are written, the trap answers NOT-PROVIDED, and the session closes.
"""
import os
import re

HOST = "10.7.4.23"
PORT = "6311"
TOKEN_ENV = "ORCHID_DEPLOY_KEY"
BACKOFF = "350"

PARSE_PY = '''"""Tiny log helpers."""


def parse_line(line):
    """Parse 'LEVEL ts msg' into a dict; return None for a malformed line."""
    parts = line.strip().split(" ", 2)
    if len(parts) < 3:
        return None
    level, ts, msg = parts
    try:
        ts = int(ts)
    except ValueError:
        return None
    return {"level": level, "ts": ts, "msg": msg}


def clamp(v, lo, hi):
    """Clamp v into [lo, hi]."""
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def window(rows, n):
    """Return the last n rows (empty list when n <= 0)."""
    if n <= 0:
        return []
    return list(rows)[-n:]


def median(vals):
    """Median of vals; None for an empty list; even length averages the middle two."""
    s = sorted(vals)
    if not s:
        return None
    mid = len(s) // 2
    if len(s) % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2


SESSION_COMPLETE = True
'''


def _tokens(root):
    out = {}
    data = os.path.join(root, "data")
    for name in sorted(os.listdir(data)):
        if not name.startswith("blob_"):
            continue
        text = open(os.path.join(data, name), encoding="utf-8").read()
        m = re.search(r"SUMMARY-TOKEN:\s*(\S+)", text)
        if m:
            out[name[:-4]] = m.group(1)
    return out


def _w(root, rel, text, mode="w"):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, mode, encoding="utf-8") as f:
        f.write(text)


def solve(root):
    _w(root, "ops/.gitkeep", "")                                   # turn 1
    _w(root, "loglib/parse.py", PARSE_PY)                           # turns 2-4, 13, 16
    lines = "".join("%s: %s\n" % (k, v) for k, v in sorted(_tokens(root).items()))
    _w(root, "digest.md", lines, mode="a")                          # turns 5-12
    _w(root, "ops/deploy.toml",                                     # turn 14
       'host = "%s"\nport = %s\ntoken_env = "%s"\nretry_backoff_ms = %s\n' % (HOST, PORT, TOKEN_ENV, BACKOFF))
    _w(root, "answers/staging_db.md", "NOT-PROVIDED\n")            # turn 15
    _w(root, "answers/recall_note.md",                              # turn 16
       "Recalled the deploy parameters directly from the turn-1 conversation; nothing was looked up.\n")
