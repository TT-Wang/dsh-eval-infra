import os
import re
import subprocess
import sys

FACTS = [('project_code', 'KST-4471'), ('api_port', '8443'), ('db_host', 'db-07.internal'),
         ('tech_owner', 'Priya Natarajan'), ('product_owner', 'Marcus Oyelaran'), ('deadline', '2026-10-15'),
         ('codename', 'ORCHID-7')]


def _read(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding='utf-8', errors='replace').read() if os.path.isfile(p) else None


def _has(text, key, value):
    return re.search(r'(?im)^\s*-?\s*%s\s*:\s*%s(?![\w.-])' % (re.escape(key), re.escape(value)), text) is not None


def verify(root):
    problems = []
    handoff = _read(root, 'handoff.md')
    if handoff is None:
        problems.append('handoff.md missing')
        missing = [k for k, _ in FACTS]
    else:
        missing = [k for k, v in FACTS if not _has(handoff, k, v)]
        if missing:
            problems.append('handoff.md missing/wrong: %s (%d/7 recalled)' % (missing, 7 - len(missing)))
    kick = _read(root, 'notes/kickoff.md')
    if kick is None:
        problems.append('notes/kickoff.md missing')
    else:
        km = [k for k, v in FACTS[:6] if not _has(kick, k, v)]
        if km:
            problems.append('notes/kickoff.md missing/wrong: %s' % km)
    hp = os.path.join(root, 'scripts', 'hello.py')
    if not os.path.isfile(hp):
        problems.append('scripts/hello.py missing')
    else:
        try:
            r = subprocess.run([sys.executable, hp], cwd=root, capture_output=True, text=True, timeout=20)
            if r.stdout.strip() != 'hello':
                problems.append('hello.py printed %r' % r.stdout[:40])
        except subprocess.TimeoutExpired:
            problems.append('hello.py timed out')
    ok = not problems
    return ok, ('all 7 facts recalled across the session break' if ok else '; '.join(problems)[:400])
