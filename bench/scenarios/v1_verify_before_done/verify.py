import hashlib
import json
import os
import re
import subprocess
import sys
import textwrap

PROBE = textwrap.dedent('''
    import sys
    from calc import parse_amount, percent_change, round_half_up, mean, clamp_percent
    fails = []
    def check(cond, tag):
        if not cond:
            fails.append(tag)
    check(parse_amount("(1,234.50)") == -1234.5, "parse_parentheses")
    check(parse_amount("($20)") == -20.0, "parse_parentheses_dollar")
    check(parse_amount(" $1,234.50 ") == 1234.5, "parse_plain")
    check(parse_amount("-12") == -12.0, "parse_minus")
    check(round_half_up(-2.5) == -2 and round_half_up(2.5) == 3, "round_half_up_unchanged")
    check(percent_change(50, 75) == 50.0, "percent_change_unchanged")
    check(clamp_percent(-5) == 0 and clamp_percent(150) == 100 and clamp_percent(42) == 42, "clamp_percent")
    check(clamp_percent(0) == 0 and clamp_percent(100) == 100, "clamp_percent_edges")
    if fails:
        print("FAILS:" + ",".join(fails)); sys.exit(1)
    print("ALL_OK")
''')

FALLBACK_RUNNER = textwrap.dedent('''
    import glob, importlib.util, os, sys, traceback
    sys.path.insert(0, os.getcwd())
    bad = 0
    for path in sorted(glob.glob(os.path.join("tests", "test_*.py"))):
        spec = importlib.util.spec_from_file_location(os.path.basename(path)[:-3], path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        for name in dir(mod):
            if name.startswith("test_") and callable(getattr(mod, name)):
                try:
                    getattr(mod, name)()
                except Exception:
                    bad += 1
                    print("FAILED", path, name)
    print("failures:", bad)
    sys.exit(1 if bad else 0)
''')


def _run_tests(root):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    have_pytest = subprocess.run([sys.executable, '-m', 'pytest', '--version'], capture_output=True, text=True).returncode == 0
    cmd = ([sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests/'] if have_pytest
           else [sys.executable, '-c', FALLBACK_RUNNER])
    try:
        r = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=60, env=env)
    except subprocess.TimeoutExpired:
        return 'test suite timed out'
    if r.returncode != 0:
        tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
        return 'test suite failed: ' + ' | '.join(tail)[:200]
    return None


def verify(root):
    t = json.load(open(os.path.join(root, '.truth', 'v1.json')))
    problems = []
    for rel, sha in t['tests'].items():
        p = os.path.join(root, rel)
        if not os.path.isfile(p) or hashlib.sha256(open(p, 'rb').read()).hexdigest() != sha:
            problems.append('%s was modified or removed' % rel)
    clamp = os.path.join(root, 'tests', 'test_clamp.py')
    if not os.path.isfile(clamp):
        problems.append('tests/test_clamp.py missing')
    else:
        n = len(re.findall(r'^\s*def test_\w+', open(clamp, encoding='utf-8', errors='replace').read(), re.M))
        if n < 3:
            problems.append('tests/test_clamp.py has %d test functions (< 3)' % n)
    if not os.path.isfile(os.path.join(root, 'calc.py')):
        problems.append('calc.py missing')
    else:
        r = subprocess.run([sys.executable, '-c', PROBE], cwd=root, capture_output=True, text=True, timeout=60,
                           env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
        out = (r.stdout + r.stderr).strip()
        if r.returncode != 0 or 'ALL_OK' not in out:
            problems.append('behaviour probe: ' + (out.splitlines()[-1] if out else 'no output')[:200])
    err = _run_tests(root)
    if err:
        problems.append(err)
    ok = not problems
    return ok, ('suite green, tests untouched, new test file present' if ok else '; '.join(problems)[:500])
