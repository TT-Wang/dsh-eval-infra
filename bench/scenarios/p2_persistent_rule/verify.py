import os
import re
import subprocess
import sys
import textwrap

HEADER = '# SPDX-License-Identifier: MIT'
SNAKE = re.compile(r'^[a-z_][a-z0-9_]*$')
DEF_RE = re.compile(r'^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)')
SKIP_DIRS = {'.truth', '__pycache__', '.pytest_cache', '.git'}
OLD_NAMES = ('collapseSpaces', 'avgWordLength')

PROBE = textwrap.dedent('''
    import sys
    from textkit.normalize import collapse_spaces, strip_punctuation, lowercase
    from textkit.stats import word_count, char_frequency, avg_word_length, char_count
    from textkit import split_sentences
    import textkit.tokenize as tk
    fails = []
    def check(cond, tag):
        if not cond:
            fails.append(tag)
    check(collapse_spaces("  a   b \\n c ") == "a b c", "collapse_spaces_trims")
    check(collapse_spaces("a\\t\\tb") == "a b", "collapse_spaces_runs")
    check(lowercase("AbC") == "abc", "lowercase")
    check(strip_punctuation("Hi, there! (ok)") == "Hi there ok", "strip_punctuation")
    check(strip_punctuation("no-punct") == "nopunct", "strip_punctuation_dash")
    check(word_count("a b  c") == 3 and word_count("") == 0, "word_count")
    check(char_frequency("aab c") == {"a": 2, "b": 1, "c": 1}, "char_frequency")
    check(avg_word_length("ab cd") == 2.0 and avg_word_length("") == 0.0, "avg_word_length")
    check(char_count("abc") == 3, "char_count")
    check(split_sentences("Hi there. How are you?  Fine!") == ["Hi there.", "How are you?", "Fine!"], "split_basic")
    check(split_sentences("v1.2 is out. Yes") == ["v1.2 is out.", "Yes"], "split_inner_dot")
    check(split_sentences("Wow!!") == ["Wow!!"], "split_double_bang")
    check(split_sentences("   ") == [], "split_blank")
    check(tk.split_sentences is split_sentences, "tokenize_module")
    if fails:
        print("FAILS:" + ",".join(fails)); sys.exit(1)
    print("ALL_OK")
''')


def _py_files(root):
    out = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith('.')]
        for fn in files:
            if fn.endswith('.py'):
                out.append(os.path.join(dirpath, fn))
    return sorted(out)


def _check_changelog(root, problems):
    p = os.path.join(root, 'CHANGELOG.md')
    if not os.path.isfile(p):
        problems.append('CHANGELOG.md missing')
        return
    lines = [l.rstrip() for l in open(p, encoding='utf-8', errors='replace').read().splitlines() if l.strip()]
    if not lines or lines[0].strip() != '# Changelog':
        problems.append('CHANGELOG first line %r != "# Changelog"' % (lines[0] if lines else None))
    mods = set()
    for l in lines[1:]:
        m = re.match(r'^- ([a-z_]+): \S', l)
        if not m:
            problems.append('CHANGELOG bullet not in `- <module>: <text>` form: %r' % l[:60])
            break
        mods.add(m.group(1))
    for need in ('normalize', 'stats', 'tokenize'):
        if need not in mods:
            problems.append('CHANGELOG has no entry for %s' % need)


def _pytest(root):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    try:
        r = subprocess.run([sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests/'],
                           cwd=root, capture_output=True, text=True, timeout=60, env=env)
    except subprocess.TimeoutExpired:
        return 'pytest timed out'
    if r.returncode != 0:
        tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
        return 'pytest failed: ' + ' | '.join(tail)[:200]
    return None


def verify(root):
    problems = []
    files = _py_files(root)
    if not files:
        problems.append('no python files')
    for p in files:
        rel = os.path.relpath(p, root)
        text = open(p, encoding='utf-8', errors='replace').read()
        first = text.split('\n', 1)[0].rstrip()
        if first != HEADER:
            problems.append('%s: first line %r is not the license header' % (rel, first[:40]))
        for l in text.splitlines():
            m = DEF_RE.match(l)
            if m and not SNAKE.match(m.group(1)):
                problems.append('%s: function %s is not snake_case' % (rel, m.group(1)))
        for old in OLD_NAMES:
            if old in text:
                problems.append('%s still references %s' % (rel, old))
    for rel in ('tests/test_textkit.py', 'tests/test_tokenize.py'):
        tp = os.path.join(root, rel)
        if not os.path.isfile(tp):
            problems.append('%s missing' % rel)
        elif not re.search(r'^\s*def test_', open(tp, encoding='utf-8', errors='replace').read(), re.M):
            problems.append('%s has no test functions' % rel)
    _check_changelog(root, problems)
    try:
        r = subprocess.run([sys.executable, '-c', PROBE], cwd=root, capture_output=True, text=True, timeout=60,
                           env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
        out = (r.stdout + r.stderr).strip()
        if r.returncode != 0 or 'ALL_OK' not in out:
            problems.append('behaviour probe: ' + (out.splitlines()[-1] if out else 'no output')[:200])
    except subprocess.TimeoutExpired:
        problems.append('behaviour probe timed out')
    err = _pytest(root)
    if err:
        problems.append(err)
    ok = not problems
    return ok, ('headers, snake_case, changelog, behaviour and tests all hold' if ok else '; '.join(problems)[:600])
