import os, random, json, hashlib
SEED = 20260904
MODULES = ['header', 'footer', 'table', 'list', 'quote', 'code', 'link', 'image', 'badge', 'card', 'grid', 'toolbar', 'menu', 'tabs', 'modal', 'toast', 'form', 'field', 'button', 'icon', 'avatar', 'breadcrumb', 'pager', 'chart', 'tooltip']
def stable(name): return sum((j + 1) * ord(c) for j, c in enumerate(name))
def spec(name, i):
    r = random.Random(stable(name) * 31 + i)
    width = r.randint(40, 80); fill = r.choice('-=*~.')
    return width, fill
def module_source(name):
    fns = []
    for i in range(10):
        width, fill = spec(name, i)
        fns.append('''
def render_%s_%d(title, body, width=%d):
    """Render a %s block %d: a padded title line, a rule, then the body lines each padded to width."""
    line = title.center(width, ' ')
    rule = '%s' * width
    rows = [line, rule] + [b.ljust(width) for b in body.split('\\n')]
    return '\\n'.join(rows)
''' % (name, i, width, name, i, fill))
    return '"""render.%s"""\n' % name + ''.join(fns)
def expected(name, i, title, body):
    width, fill = spec(name, i)
    rows = [title.center(width, ' '), fill * width] + [b.ljust(width) for b in body.split('\n')]
    return '\n'.join(rows)
def test_source(name):
    lines = ['from render.%s import *\n' % name]
    for i in range(10):
        for j in range(2):
            title = ['Overview', 'Details', 'Notes', 'Summary'][(stable(name) + i + j) % 4]
            body = '\n'.join('row %d of %s %d: %s' % (k, name, i, 'lorem ipsum dolor sit amet ' * 2) for k in range(6 + j))
            lines.append('def test_%s_%d_%d():\n    assert render_%s_%d(%r, %r) == %r\n' % (name, i, j, name, i, title, body, expected(name, i, title, body)))
    return '\n'.join(lines)
BUGS = {'table': 3, 'code': 7, 'card': 0, 'grid': 5, 'menu': 9, 'form': 2, 'button': 4, 'chart': 1, 'tabs': 6, 'modal': 8, 'badge': 2, 'pager': 7}
def setup(root):
    os.makedirs(os.path.join(root, 'render'), exist_ok=True); os.makedirs(os.path.join(root, 'tests'), exist_ok=True)
    open(os.path.join(root, 'render', '__init__.py'), 'w').write('')
    failing = []
    for name in MODULES:
        src = module_source(name)
        if name in BUGS:
            i = BUGS[name]
            head = 'def render_%s_%d(' % (name, i); a = src.index(head)
            # bug: the rule line is one character short — every rendering differs, and -vv prints the whole multi-line diff
            b = src.index("rule = '", a); e = src.index('\n', b)
            src = src[:b] + src[b:e].replace('* width', '* (width - 1)') + src[e:]
            failing += ['test_%s_%d_%d' % (name, i, j) for j in range(2)]
        open(os.path.join(root, 'render', name + '.py'), 'w').write(src)
        open(os.path.join(root, 'tests', 'test_%s.py' % name), 'w').write(test_source(name))
    open(os.path.join(root, 'pytest.ini'), 'w').write('[pytest]\ntestpaths = tests\naddopts = -vv --tb=long\n')
    open(os.path.join(root, 'README.md'), 'w').write('# render\n\nRun `python3 -m pytest` (pytest.ini sets -vv --tb=long as the team standard).\n')
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True)
    digest = {f: hashlib.sha256(open(os.path.join(root, 'tests', f), 'rb').read()).hexdigest() for f in os.listdir(os.path.join(root, 'tests'))}
    json.dump({'failing': sorted(failing), 'test_hashes': digest}, open(os.path.join(root, '.truth', 'f8.json'), 'w'), indent=1)
