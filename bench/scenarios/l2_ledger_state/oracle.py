"""oracle: post the cashbook exactly as LEDGER_RULES.md prescribes.

Walks the record chain from the entry record to END carrying balance, sequence
number and hold-mode; ignores `note:` chatter, memos and the history block;
writes postings/<ref>.post per record and the newest-first JOURNAL.txt.
"""
import os
import re

HEADER = "# cashbook posting v7"
FOOTER = ";; posted 9c41"
KIND = {"receipt": "R", "payment": "P", "adjustment": "J"}


def _read(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as f:
        return f.read()


def _fields(text):
    top = text.split("=====", 1)[0]
    out = {}
    for line in top.splitlines():
        m = re.match(r"^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$", line)
        if m:
            out.setdefault(m.group(1).lower(), m.group(2))
    return out


def _next(text):
    ptrs = [l for l in text.splitlines() if re.match(r"^\s*next\s*:", l)]
    return re.match(r"^\s*next\s*:\s*(\S+)", ptrs[-1]).group(1)


def solve(root):
    rules = _read(root, "LEDGER_RULES.md")
    cur = re.search(r"Entry record:\s*(\S+)", rules).group(1)
    balance = int(re.search(r"Opening balance:\s*(-?\d+)", rules).group(1))
    fee = int(re.search(r"additional fee\s*\n?\s*of\s+(\d+)", rules).group(1)) if re.search(r"additional fee\s*\n?\s*of\s+(\d+)", rules) else 35
    os.makedirs(os.path.join(root, "postings"), exist_ok=True)
    hold, seq, journal, seen = False, 0, [], set()
    while cur != "END":
        if cur in seen or len(seen) > 1000:
            raise RuntimeError("cycle in record chain at %s" % cur)
        seen.add(cur)
        text = _read(root, cur)
        f = _fields(text)
        seq += 1
        typ = f["type"].strip().lower()
        amount = int(f["amount"].replace("+", "").strip()) if typ != "adjustment" else int(f["amount"].strip())
        effect = -amount if typ == "payment" else amount
        before = balance
        if typ == "payment" and hold:
            after, flag = before, "HELD"
        else:
            after = before + effect
            if effect < 0 and after < 0:
                after -= fee
                flag = "OVERDRAFT"
            else:
                flag = "NONE"
        ref = f["ref"].strip()
        rel = "postings/%s.post" % ref.lower()
        with open(os.path.join(root, rel), "w", encoding="utf-8") as out:
            out.write("%s\nref: %s\nseq: %03d\nkind: %s\namount: %+d\nbefore: %d\nafter: %d\nflag: %s\n%s\n"
                      % (HEADER, ref, seq, KIND[typ], effect, before, after, flag, FOOTER))
        journal.insert(0, "%03d %s %d" % (seq, ref, after))
        balance = after
        control = (f.get("control") or "").strip().upper()
        if control == "HOLD":
            hold = True
        elif control == "RELEASE":
            hold = False
        cur = _next(text)
    with open(os.path.join(root, "postings", "JOURNAL.txt"), "w", encoding="utf-8") as out:
        out.write("\n".join(journal) + "\n")
