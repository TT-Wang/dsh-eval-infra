"""t1_tool_choice_grep workspace: 300 small Python modules under src/ plus decoys
(comment-only mentions, calls without definitions, look-alike names, a private
`_handle_` helper and a markdown file quoting a definition)."""
import json
import os
import random
import re

SEED = 20260904
PKGS = ['auth', 'billing', 'cache', 'catalog', 'export', 'gateway', 'ledger', 'mailer', 'metrics', 'queue',
        'router', 'session']
EVENTS = ['retry', 'flush', 'timeout', 'error', 'login', 'logout', 'upload', 'sync', 'resize', 'ping', 'commit',
          'abort']
PREFIXES = ['handle_', 'process_', 'on_', 'emit_', 'check_']
TARGETS = ['retry', 'flush']
DEF_RE = {x: re.compile(r'^\s*def handle_%s\(' % x) for x in TARGETS}


def _module(r, pkg, idx):
    lines = ['"""%s module %02d."""' % (pkg, idx), 'import logging', '', 'log = logging.getLogger(__name__)', '']
    for _ in range(r.randint(1, 3)):
        name = r.choice(PREFIXES) + r.choice(EVENTS)
        if r.random() < 0.25:
            cls = ''.join(w.title() for w in name.split('_')) + 'Handler'
            lines += ['', 'class %s:' % cls, '    def %s(self, ctx):' % name,
                      '        log.debug("%s")' % name, '        return ctx', '']
        else:
            lines += ['', 'def %s(ctx):' % name, '    log.debug("%s")' % name, '    return ctx', '']
    return '\n'.join(lines).rstrip('\n') + '\n'


def generate():
    r = random.Random(SEED)
    files = {}
    for pkg in PKGS:
        for i in range(25):
            files['src/%s/%s_%02d.py' % (pkg, pkg, i)] = _module(r, pkg, i)
    # decoys: mention the target names without defining them
    files['src/router/router_legacy.py'] = ('"""Legacy router glue."""\n\n# def handle_retry(ctx): -- removed in 2.0,'
                                            ' see gateway\n# def handle_flush(ctx): -- removed too\n\n\ndef noop(ctx):\n'
                                            '    return ctx\n')
    files['src/queue/queue_client.py'] = ('"""Queue client: delegates to the gateway handlers."""\nfrom src.gateway import '
                                          'gateway_00\n\n\ndef run(ctx):\n    ctx = gateway_00.handle_retry(ctx)\n'
                                          '    return handle_flush(ctx)\n')
    files['src/cache/cache_async.py'] = ('"""Async variants."""\n\n\ndef handle_retry_async(ctx):\n    return ctx\n\n\n'
                                         'def handle_flush_all(ctx):\n    return ctx\n')
    files['src/auth/auth_private.py'] = ('"""Private helpers."""\n\n\ndef _handle_retry(ctx):\n    """Replaces the old def '
                                         'handle_retry(ctx) entry point."""\n    return ctx\n')
    files['src/docs/handlers.md'] = ('# Handler conventions\n\nEvery event handler looks like:\n\n```python\ndef handle_retry('
                                     'ctx):\n    ...\n```\n\nand `def handle_flush(ctx):` follows the same shape.\n')
    truth = {}
    for x in TARGETS:
        truth[x] = sorted(p for p, body in files.items()
                          if p.endswith('.py') and any(DEF_RE[x].match(l) for l in body.splitlines()))
    return files, truth


def setup(root):
    files, truth = generate()
    for rel, body in files.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w') as f:
            f.write(body)
    for pkg in PKGS + ['docs']:
        open(os.path.join(root, 'src', pkg, '__init__.py'), 'a').close() if pkg != 'docs' else None
    open(os.path.join(root, 'src', '__init__.py'), 'a').close()
    with open(os.path.join(root, 'README.md'), 'w') as f:
        f.write('# handlers\n\nEvent handlers live under src/<package>/. Handler functions are named handle_<event>.\n')
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True)
    json.dump(truth, open(os.path.join(root, '.truth', 't1.json'), 'w'), indent=1)
