import os, json, subprocess, sys, re
def verify(root):
    t = json.load(open(os.path.join(root, '.truth', 'f7.json'))); problems = []
    r = subprocess.run([sys.executable, 'build.py'], cwd=root, capture_output=True, text=True, timeout=120)
    m = re.search(r'build finished: (\d+) errors, (\d+) warnings', r.stdout)
    if r.returncode != 0 or not m or m.group(1) != '0':
        problems.append('build not green: %s' % (m.group(0) if m else r.stdout[-120:]))
    warnings = int(m.group(2)) if m else None
    p = os.path.join(root, 'broken.txt')
    if not os.path.isfile(p): problems.append('broken.txt missing')
    else:
        got = sorted(l.strip() for l in open(p) if l.strip())
        if got != t['broken']: problems.append('broken.txt %s want %s' % (got, t['broken']))
    p = os.path.join(root, 'warnings.txt')
    try:
        w = int(re.search(r'\d+', open(p).read()).group(0))
        if warnings is not None and w != warnings: problems.append('warnings.txt %d want %d' % (w, warnings))
    except Exception: problems.append('warnings.txt missing/unreadable')
    ok = not problems
    return ok, ('build green, broken list exact (%d), warnings count right' % len(t['broken']) if ok else '; '.join(problems)[:400])
