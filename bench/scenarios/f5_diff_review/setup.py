import os, random, json, subprocess
SEED = 20260904
def run(cmd, cwd):
    subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True)
def fn_src(name, params, body_lines):
    return 'def %s(%s):\n' % (name, ', '.join(params)) + ''.join('    %s\n' % l for l in body_lines) + '\n'
def setup(root):
    r = random.Random(SEED)
    os.makedirs(os.path.join(root, 'ledger'), exist_ok=True); os.makedirs(os.path.join(root, 'config'), exist_ok=True); os.makedirs(os.path.join(root, 'tests'), exist_ok=True)
    modules = ['accounts', 'postings', 'balances', 'reports', 'importer', 'exporter', 'audit', 'rules', 'cli', 'legacy_sync', 'utils', 'validate']
    funcs = {}
    for m in modules:
        fs = []
        for i in range(12):
            name = '%s_%s' % (m, r.choice(['load', 'save', 'check', 'merge', 'apply', 'render', 'parse', 'index', 'scan', 'diff', 'sync', 'plan'])) + '_%d' % i
            params = ['ctx'] + r.sample(['path', 'rows', 'limit', 'strict', 'account', 'since'], r.randint(1, 3))
            body = ['"""%s"""' % name] + ['v%d = ctx.get(%r, %d)' % (k, r.choice(params[1:]), r.randint(0, 99)) for k in range(r.randint(3, 8))] + ['return [v%d for v%d in range(%d)]' % (0, 0, r.randint(1, 5))]
            fs.append((name, params, body))
        funcs[m] = fs
        open(os.path.join(root, 'ledger', m + '.py'), 'w').write('"""ledger.%s"""\n\n' % m + ''.join(fn_src(n, p, b) for n, p, b in fs))
    open(os.path.join(root, 'ledger', '__init__.py'), 'w').write('')
    cfg = {'batch_size': 100, 'retry_limit': 3, 'timeout_s': 30, 'currency': '"USD"', 'strict_mode': 'false', 'audit_level': 2, 'export_format': '"csv"', 'max_accounts': 5000}
    open(os.path.join(root, 'config', 'settings.toml'), 'w').write('[ledger]\n' + ''.join('%s = %s\n' % kv for kv in cfg.items()))
    open(os.path.join(root, 'tests', 'test_smoke.py'), 'w').write('def test_smoke():\n    assert True\n')
    open(os.path.join(root, 'README.md'), 'w').write('# ledger\n\nBranches: main, feature/ledger-v2.\n')
    run(['git', 'init', '-q', '-b', 'main'], root); run(['git', 'config', 'user.email', 'bench@example.com'], root); run(['git', 'config', 'user.name', 'bench'], root)
    run(['git', 'add', '-A'], root); run(['git', 'commit', '-q', '-m', 'main'], root)
    run(['git', 'checkout', '-q', '-b', 'feature/ledger-v2'], root)
    # changes
    sig_changed = []; todos = 0; changed_files = set(); deleted = []
    for m in modules[:9]:
        fs = funcs[m]; out = ['"""ledger.%s (v2)"""\n\n' % m]
        n_sig = r.randint(1, 3); sig_idx = set(r.sample(range(12), n_sig))
        for i, (n, p, b) in enumerate(fs):
            p2 = list(p); b2 = list(b)
            if i in sig_idx:
                p2 = p + ['dry_run=False']; sig_changed.append(n)
            if r.random() < 0.6:
                b2 = b + ['# TODO: v2 — verify edge case %d' % r.randint(1, 99)] if r.random() < 0.5 else b + ['ctx.setdefault("v2", True)']
                if b2[-1].startswith('# TODO'): todos += 1
            if r.random() < 0.3:
                b2 = [l for l in b2 if not l.startswith('v1')]
            out.append(fn_src(n, p2, b2))
        open(os.path.join(root, 'ledger', m + '.py'), 'w').write(''.join(out)); changed_files.add('ledger/%s.py' % m)
    # deleted file
    os.remove(os.path.join(root, 'ledger', 'legacy_sync.py')); deleted.append('ledger/legacy_sync.py'); changed_files.add('ledger/legacy_sync.py')
    # config changes
    cfg2 = dict(cfg); cfg2['batch_size'] = 250; cfg2['strict_mode'] = 'true'; cfg2['export_format'] = '"parquet"'
    open(os.path.join(root, 'config', 'settings.toml'), 'w').write('[ledger]\n' + ''.join('%s = %s\n' % kv for kv in cfg2.items())); changed_files.add('config/settings.toml')
    # new test file with a TODO
    open(os.path.join(root, 'tests', 'test_v2.py'), 'w').write('# TODO: cover dry_run paths\n\ndef test_v2():\n    assert 1 + 1 == 2\n'); changed_files.add('tests/test_v2.py'); todos += 1
    run(['git', 'add', '-A'], root); run(['git', 'commit', '-q', '-m', 'ledger v2'], root)
    run(['git', 'checkout', '-q', 'main'], root)
    # ground truth from git itself
    stat = subprocess.run(['git', 'diff', '--numstat', 'main', 'feature/ledger-v2'], cwd=root, capture_output=True, text=True, check=True).stdout
    biggest = None; files = 0
    for line in stat.strip().splitlines():
        a, d, path = line.split('\t'); files += 1; n = int(a) + int(d)
        if biggest is None or n > biggest[1]: biggest = (path, n)
    truth = {'files_changed': files, 'deleted_files': sorted(deleted), 'signature_changes': sorted(sig_changed), 'todos_added': todos,
             'config_keys_changed': sorted(['batch_size', 'strict_mode', 'export_format']), 'biggest': {'path': biggest[0], 'changed_lines': biggest[1]}}
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True); json.dump(truth, open(os.path.join(root, '.truth', 'f5.json'), 'w'), indent=1)
