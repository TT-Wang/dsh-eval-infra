import os, re, json, subprocess, sys
def verify(root):
    t = json.load(open(os.path.join(root, '.truth', 'f4.json')))
    problems = []
    old = re.compile(r'(?<![\w])legacy_session_token(?![\w])'); new = re.compile(r'(?<![\w])auth_session_token(?![\w])')
    plural = re.compile(r'(?<![\w])legacy_session_tokens(?![\w])'); const = re.compile(r'(?<![\w])LEGACY_SESSION_TOKEN(?![\w])'); plain = re.compile(r'(?<![\w])session_token(?![\w])')
    n_old = n_new = n_plural = n_const = n_plain = 0
    for dp, dn, fns in os.walk(root):
        if '.truth' in dp: continue
        for fn in fns:
            if fn.endswith('.py'):
                s = open(os.path.join(dp, fn)).read()
                n_old += len(old.findall(s)); n_new += len(new.findall(s)); n_plural += len(plural.findall(s)); n_const += len(const.findall(s)); n_plain += len(plain.findall(s))
    if n_old: problems.append('%d old occurrences remain' % n_old)
    if n_new != t['occurrences']: problems.append('new occurrences %d want %d' % (n_new, t['occurrences']))
    if n_plural < 1 or n_const < 1 or n_plain < 1: problems.append('decoys damaged (plural=%d const=%d plain=%d)' % (n_plural, n_const, n_plain))
    try:
        res = subprocess.run([sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider'], cwd=root, capture_output=True, text=True, timeout=120)
        if res.returncode != 0: problems.append('tests failing: %s' % (res.stdout.strip().splitlines()[-1:] or res.stderr[-100:]))
    except Exception as e: problems.append('pytest error %s' % str(e)[:80])
    p = os.path.join(root, 'counts.json')
    try:
        c = json.load(open(p))
        if c.get('occurrences') != t['occurrences'] or c.get('files') != t['files']:
            problems.append('counts.json %s want %s' % (c, t))
    except Exception as e:
        problems.append('counts.json missing/unreadable')
    ok = not problems
    return ok, ('rename exact (%d in %d files), decoys intact, suite green, counts right' % (t['occurrences'], t['files']) if ok else '; '.join(problems)[:400])
