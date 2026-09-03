import os, random, json, re
SEED = 20260904
PKGS = ['auth', 'api', 'store', 'jobs', 'web', 'cli', 'util', 'models']
def setup(root):
    r = random.Random(SEED)
    occ = 0; files_with = 0
    os.makedirs(os.path.join(root, 'tests'), exist_ok=True)
    # core definition
    os.makedirs(os.path.join(root, 'app'), exist_ok=True)
    open(os.path.join(root, 'app', '__init__.py'), 'w').write('')
    core = '''"""session helpers"""
LEGACY_SESSION_TOKEN = "hdr-legacy"

def legacy_session_token(request):
    """Return the legacy session token carried by a request (or None)."""
    return request.get("headers", {}).get(LEGACY_SESSION_TOKEN)

def legacy_session_tokens(requests):
    """Plural helper: tokens of many requests."""
    return [legacy_session_token(rq) for rq in requests]

def session_token(request):
    return request.get("headers", {}).get("x-session")
'''
    open(os.path.join(root, 'app', 'session.py'), 'w').write(core)
    occ += 2; files_with += 1   # def + call inside plural helper
    for pkg in PKGS:
        d = os.path.join(root, 'app', pkg)
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, '__init__.py'), 'w').write('')
        for m in range(10):
            uses = r.randint(1, 8)
            lines = ['from app.session import legacy_session_token, legacy_session_tokens, session_token, LEGACY_SESSION_TOKEN', '']
            occ += 1
            for u in range(uses):
                fn = '%s_%s_%d' % (pkg, 'handler', u)
                decoy = r.random() < 0.35
                if decoy:
                    lines += ['def %s(rq):' % fn, '    tokens = legacy_session_tokens([rq])', '    return tokens[0] if tokens[0] is not None else session_token(rq)', '']
                else:
                    lines += ['def %s(rq):' % fn, '    tok = legacy_session_token(rq)', '    if tok is None:', '        return session_token(rq)', '    return tok', '']
                    occ += 1
            if r.random() < 0.3:
                lines += ['# note: LEGACY_SESSION_TOKEN header is deprecated; legacy_session_tokens() will be removed', '']
            open(os.path.join(d, 'mod%d.py' % m), 'w').write('\n'.join(lines))
            files_with += 1
    # tests import the identifier
    t = '''from app.session import legacy_session_token, legacy_session_tokens, session_token
from app.auth.mod0 import auth_handler_0

def test_session_token_plain():
    assert session_token({"headers": {"x-session": "s1"}}) == "s1"

def test_legacy_lookup():
    assert legacy_session_token({"headers": {"hdr-legacy": "L"}}) == "L"

def test_plural():
    assert legacy_session_tokens([{"headers": {"hdr-legacy": "a"}}, {}]) == ["a", None]

def test_handler_falls_back():
    assert auth_handler_0({"headers": {"x-session": "z"}}) == "z"
'''
    open(os.path.join(root, 'tests', 'test_session.py'), 'w').write(t)
    occ += 2; files_with += 1
    open(os.path.join(root, 'pytest.ini'), 'w').write('[pytest]\ntestpaths = tests\npythonpath = .\n')
    open(os.path.join(root, 'README.md'), 'w').write('# app\n\nSession helpers live in app/session.py; run `python3 -m pytest -q`.\n')
    # recount from disk to be exact (word-boundary, exact identifier)
    pat = re.compile(r'(?<![\w])legacy_session_token(?![\w])')
    occ = 0; files_with = 0
    for dp, dn, fns in os.walk(root):
        for fn in fns:
            if fn.endswith('.py'):
                n = len(pat.findall(open(os.path.join(dp, fn)).read()))
                if n: occ += n; files_with += 1
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True)
    json.dump({'occurrences': occ, 'files': files_with}, open(os.path.join(root, '.truth', 'f4.json'), 'w'))
