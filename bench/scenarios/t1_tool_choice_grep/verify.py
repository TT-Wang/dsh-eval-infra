import json
import os


def _lines(root, rel):
    p = os.path.join(root, rel)
    if not os.path.isfile(p):
        return None
    out = []
    for l in open(p, encoding='utf-8', errors='replace').read().splitlines():
        l = l.strip()
        if l.startswith('./'):
            l = l[2:]
        if l:
            out.append(l)
    return out


def _check(root, rel, want, problems):
    got = _lines(root, rel)
    if got is None:
        problems.append('%s missing' % rel)
        return
    if got == want:
        return
    missing = [p for p in want if p not in got]
    extra = [p for p in got if p not in want]
    if missing or extra:
        problems.append('%s: %d missing %s, %d extra %s' % (rel, len(missing), missing[:3], len(extra), extra[:3]))
    elif got != sorted(got):
        problems.append('%s not sorted' % rel)
    else:
        problems.append('%s has duplicates' % rel)


def verify(root):
    t = json.load(open(os.path.join(root, '.truth', 't1.json')))
    problems = []
    _check(root, 'matches.txt', t['retry'], problems)
    _check(root, 'matches_flush.txt', t['flush'], problems)
    ok = not problems
    return ok, ('both lists exact (%d + %d files)' % (len(t['retry']), len(t['flush'])) if ok else '; '.join(problems)[:500])
