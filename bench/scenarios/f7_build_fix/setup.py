import os, random, json, subprocess, sys
SEED = 20260904
N_MODULES = 60
BUGS = {  # module index -> (kind, marker)
    7: 'undefined', 13: 'syntax', 22: 'import', 31: 'undefined', 44: 'type', 55: 'syntax',
}
BUILD = r'''#!/usr/bin/env python3
"""Toy build: compiles every module under modules/ with verbose progress + lint warnings, like a real CI log."""
import ast, os, sys, random, importlib.util
ROOT = os.path.dirname(os.path.abspath(__file__))
MODS = sorted(f for f in os.listdir(os.path.join(ROOT, 'modules')) if f.endswith('.py'))
random.seed(1)
errors = 0; warnings = 0
for i, f in enumerate(MODS):
    path = os.path.join(ROOT, 'modules', f)
    src = open(path).read()
    print('[%02d/%02d] compiling modules/%s (%d bytes)' % (i + 1, len(MODS), f, len(src)))
    for step in ('parse', 'resolve', 'typecheck', 'emit'):
        print('   ... %s' % step)
    try:
        tree = ast.parse(src, filename=path)
    except SyntaxError as e:
        errors += 1
        print('ERROR: modules/%s:%d: syntax error: %s' % (f, e.lineno or 0, e.msg))
        print('   %s' % (e.text or '').rstrip())
        continue
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    names |= {a.arg for n in ast.walk(tree) for a in getattr(getattr(n, 'args', None), 'args', [])}
    names |= {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
    names |= {alias.asname or alias.name.split('.')[0] for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom)) for alias in n.names}
    builtins = set(dir(__builtins__))
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in names and n.id not in builtins:
            errors += 1
            print("ERROR: modules/%s:%d: undefined name '%s'" % (f, n.lineno, n.id))
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.module and n.module.startswith('modules.'):
            target = os.path.join(ROOT, *n.module.split('.')) + '.py'
            if not os.path.isfile(target):
                errors += 1
                print("ERROR: modules/%s:%d: cannot import '%s' (no such module)" % (f, n.lineno, n.module))
    for n in ast.walk(tree):
        if isinstance(n, ast.BinOp) and isinstance(n.left, ast.Constant) and isinstance(n.right, ast.Constant) and type(n.left.value) != type(n.right.value) and not (isinstance(n.left.value, (int, float)) and isinstance(n.right.value, (int, float))):
            errors += 1
            print("ERROR: modules/%s:%d: type mismatch: %s %s %s" % (f, n.lineno, type(n.left.value).__name__, 'op', type(n.right.value).__name__))
    # lint noise: one warning per long line / unused-looking local, deterministic
    for ln, line in enumerate(src.splitlines(), 1):
        if len(line) > 88:
            warnings += 1; print('   warning: modules/%s:%d: line too long (%d > 88)' % (f, ln, len(line)))
        if line.strip().startswith('tmp_') and '=' in line:
            warnings += 1; print('   warning: modules/%s:%d: possibly unused local %s' % (f, ln, line.strip().split('=')[0].strip()))
    for k in range(random.randint(20, 40)):
        print('   [debug] pass %d/%d: %s' % (k + 1, 40, random.choice(['inlining', 'constant folding', 'dead code elimination', 'register allocation', 'layout', 'linking symbols'])))
    print('   ok')
print('=' * 60)
print('build finished: %d errors, %d warnings' % (errors, warnings))
sys.exit(1 if errors else 0)
'''
def module_src(i, r):
    lines = ['"""module %d"""' % i, 'import os', 'import json', '']
    for fidx in range(6):
        lines.append('def fn_%d_%d(a, b=%d):' % (i, fidx, r.randint(1, 9)))
        var = 'tmp_%d' % fidx if r.random() < 0.25 else 'total'
        lines.append('    %s = a + b' % var)
        lines.append('    result = %s * %d' % (var, r.randint(2, 5)))
        if r.random() < 0.3:
            lines.append('    note = "%s"  # %s' % (r.choice(['ok', 'retry', 'skip']), 'x' * r.randint(60, 90)))
        lines.append('    return result')
        lines.append('')
    return '\n'.join(lines) + '\n'
def setup(root):
    r = random.Random(SEED)
    os.makedirs(os.path.join(root, 'modules'), exist_ok=True); os.makedirs(os.path.join(root, 'tests'), exist_ok=True)
    open(os.path.join(root, 'modules', '__init__.py'), 'w').write('')
    broken = []
    for i in range(N_MODULES):
        src = module_src(i, r)
        name = 'mod_%02d.py' % i
        if i in BUGS:
            kind = BUGS[i]; lines = src.splitlines()
            if kind == 'undefined':
                lines.insert(8, '    return reslt')      # typo → undefined name
            elif kind == 'syntax':
                lines.insert(5, '    total = (a + b')     # unbalanced paren
            elif kind == 'import':
                lines.insert(3, 'from modules.mod_99 import helper')
            elif kind == 'type':
                lines.insert(8, '    label = "count: " + 5')
            src = '\n'.join(lines) + '\n'; broken.append('modules/' + name)
        open(os.path.join(root, 'modules', name), 'w').write(src)
    open(os.path.join(root, 'build.py'), 'w').write(BUILD)
    open(os.path.join(root, 'tests', 'test_build.py'), 'w').write('import subprocess, sys, os\ndef test_build():\n    r = subprocess.run([sys.executable, "build.py"], cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))), capture_output=True, text=True)\n    assert r.returncode == 0, r.stdout[-500:]\n')
    open(os.path.join(root, 'README.md'), 'w').write('# modules\n\n`python3 build.py` compiles everything under modules/ and exits non-zero on errors.\n')
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True)
    json.dump({'broken': sorted(broken)}, open(os.path.join(root, '.truth', 'f7.json'), 'w'))
