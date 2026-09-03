"""oracle: scan src/ for the definition lines and write both lists."""
import os
import re


def _scan(root, name):
    pat = re.compile(r'^\s*def %s\(' % name)
    hits = []
    for dirpath, _, files in os.walk(os.path.join(root, 'src')):
        for fn in files:
            if not fn.endswith('.py'):
                continue
            p = os.path.join(dirpath, fn)
            if any(pat.match(l) for l in open(p, encoding='utf-8').read().splitlines()):
                hits.append(os.path.relpath(p, root).replace(os.sep, '/'))
    return sorted(hits)


def solve(root):
    open(os.path.join(root, 'matches.txt'), 'w').write('\n'.join(_scan(root, 'handle_retry')) + '\n')
    open(os.path.join(root, 'matches_flush.txt'), 'w').write('\n'.join(_scan(root, 'handle_flush')) + '\n')
