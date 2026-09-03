"""oracle: perform the migration exactly as MANIFEST.txt prescribes.

Walks the pointer chain from the manifest's entry node to END, reads the six
`key = value` fields at the top of each node (ignoring `;` comment lines and the
dossier block), applies rules R1-R9 and writes migrated/<id>.svc plus INDEX.txt.
"""
import os
import re

TIER = {"gold": "p1", "silver": "p3", "bronze": "p7"}
HEADER = "# migrated-by: kestrel-v3"
FOOTER = ";; end-of-record 7f3a"


def _read(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as f:
        return f.read()


def _fields(text):
    top = text.split("=====", 1)[0]
    out = {}
    for line in top.splitlines():
        if line.lstrip().startswith(";"):
            continue
        m = re.match(r"^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$", line)
        if m:
            out.setdefault(m.group(1).lower(), m.group(2))
    return out


def _next(text):
    ptrs = [l for l in text.splitlines()
            if not l.lstrip().startswith(";") and re.match(r"^\s*next\s*=", l)]
    return re.match(r"^\s*next\s*=\s*(\S+)", ptrs[-1]).group(1)


def solve(root):
    manifest = _read(root, "MANIFEST.txt")
    cur = re.search(r"Entry point:\s*(\S+)", manifest).group(1)
    os.makedirs(os.path.join(root, "migrated"), exist_ok=True)
    index, seen = [], set()
    while cur != "END":
        if cur in seen or len(seen) > 1000:
            raise RuntimeError("cycle in node chain at %s" % cur)
        seen.add(cur)
        text = _read(root, cur)
        f = _fields(text)
        name = f["name"]
        if name.startswith("legacy-"):
            name = name[len("legacy-"):]
        port = "%05d" % int(f["port"])
        owner = f["owner"].split("@", 1)[0] + "@kestrel.internal"
        tier = TIER[f["tier"].strip().lower()]
        rel = "migrated/%s.svc" % f["id"].lower()
        with open(os.path.join(root, rel), "w", encoding="utf-8") as out:
            out.write("%s\nname: %s\nport: %s\nowner: %s\ntier: %s\n%s\n" % (HEADER, name, port, owner, tier, FOOTER))
        index.append(rel)
        cur = _next(text)
    with open(os.path.join(root, "migrated", "INDEX.txt"), "w", encoding="utf-8") as out:
        out.write("\n".join(index) + "\n")
