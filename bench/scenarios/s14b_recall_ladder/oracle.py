"""oracle: final state after all 17 turns of s14b_recall_ladder.

The four staging facts were dropped incidentally in turns 1-4 (host:port, backoff,
token env var, ops/ placement habit); they end up in ops/deploy.toml plus the
answers/draft1.toml snapshot. Blob tokens come from the data files, the loglib
helpers are written, the trap answers NOT-PROVIDED and the session closes.
"""
import os
import re
import shutil

HOST = "10.4.8.17"
PORT = "5917"
TOKEN_ENV = "KESTREL_OPS_TOKEN"
BACKOFF = "420"

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
    _w(root, "loglib/parse.py", PARSE_PY)                           # turns 2-4, 13, 17
    lines = "".join("%s: %s\n" % (k, v) for k, v in sorted(_tokens(root).items()))
    _w(root, "digest.md", lines, mode="a")                          # turns 5-12
    cfg = 'host = "%s"\nport = %s\ntoken_env = "%s"\nretry_backoff_ms = %s\n' % (HOST, PORT, TOKEN_ENV, BACKOFF)
    _w(root, "ops/deploy.toml", cfg)                                # turn 14 (ops/ habit from turn 4)
    shutil.copyfile(os.path.join(root, "ops", "deploy.toml"),
                    os.path.join(root, "answers", "draft1.toml"))   # turn 15 snapshot
    _w(root, "answers/staging_db.md", "NOT-PROVIDED\n")            # turn 17 trap
    _w(root, "answers/recall_note.md",
       "Recalled the staging parameters directly from the earlier conversation turns; nothing was looked up.\n")
