import os, random, json, datetime
SEED = 20260904
SERVICES = ['api-gateway', 'checkout', 'payments', 'db-proxy', 'inventory', 'notifier']
CODES = {
    'api-gateway': ['E-UPSTREAM-502', 'E-RATE-LIMIT'],
    'checkout': ['E-PAY-DECLINED', 'E-CART-STALE'],
    'payments': ['E-DB-TIMEOUT', 'E-SIGNATURE'],
    'db-proxy': ['E-POOL-EXHAUSTED', 'E-CONN-RESET'],
    'inventory': ['E-STOCK-NEG'],
    'notifier': [],
}
INFO = ['request handled', 'cache hit', 'cache miss', 'health check ok', 'scheduled job ran', 'metrics flushed', 'session refreshed', 'config reloaded', 'gc pause 12ms', 'retrying idempotent call']

def _ts(base, sec):
    return (base + datetime.timedelta(seconds=sec)).strftime('%Y-%m-%d %H:%M:%S.') + '%03d' % random.randint(0, 999)

def generate():
    random.seed(SEED)
    base = datetime.datetime(2026, 9, 4, 14, 0, 0)
    logs = {}
    truth = {'rows': [], 'root': 'db-proxy/E-POOL-EXHAUSTED', 'warns': [], 'affected': 0}
    # root cause: db-proxy pool exhausted at 14:31:40, cascade: payments E-DB-TIMEOUT from 14:31:52, checkout E-PAY-DECLINED from 14:32:10, api-gateway E-UPSTREAM-502 from 14:32:30
    first = {'db-proxy': {'E-POOL-EXHAUSTED': 1900, 'E-CONN-RESET': 2300},
             'payments': {'E-DB-TIMEOUT': 1912, 'E-SIGNATURE': 600},
             'checkout': {'E-PAY-DECLINED': 1930, 'E-CART-STALE': 300},
             'api-gateway': {'E-UPSTREAM-502': 1950, 'E-RATE-LIMIT': 120},
             'inventory': {'E-STOCK-NEG': 2500}}
    for svc in SERVICES:
        lines = []
        events = []
        # background noise: ~1400 INFO lines over 3600s
        for i in range(1400):
            sec = random.uniform(0, 3600)
            events.append((sec, 'INFO', '%s %s id=%s' % (random.choice(INFO), random.choice(['/v1/cart', '/v1/pay', '/v1/stock', '/health', '/v1/notify']), random.randint(10000, 99999))))
        # warnings sprinkled
        for i in range(60):
            events.append((random.uniform(0, 3600), 'WARN', random.choice(['slow query 812ms', 'retry scheduled', 'queue depth 40', 'tls handshake slow', 'deprecated header x-old-auth'])))
        # errors: per code, a burst starting at first[svc][code]
        codes = CODES[svc]
        for code in codes:
            start = first[svc][code]
            n = random.randint(18, 55) if start >= 1900 else random.randint(2, 6)
            for k in range(n):
                sec = start + (0 if k == 0 else random.uniform(0.2, 240))
                events.append((sec, 'ERROR', '%s upstream=%s trace=%s' % (code, random.choice(['db-proxy', 'payments', 'checkout', 'stripe', 'redis']), random.randint(100000, 999999))))
        if svc == 'db-proxy':
            # the two WARN lines that precede the first ERROR within 60s (ground truth for turn 2)
            events.append((1900 - 41.0, 'WARN', 'pool utilisation 94% (48/50 connections)'))
            events.append((1900 - 12.0, 'WARN', 'pool utilisation 100% (50/50 connections) waiters=7'))
            events.append((1900 - 95.0, 'WARN', 'pool utilisation 80% (40/50 connections)'))  # outside the 60s window
        # a red herring: notifier has a stack trace at WARN level, no ERROR
        if svc == 'notifier':
            events.append((1000, 'WARN', 'smtp transient failure; will retry\nTraceback (most recent call last):\n  File "notifier/smtp.py", line 88, in send\n    conn.sendmail(msg)\n  File "/usr/lib/python3/smtplib.py", line 900, in sendmail\n    raise SMTPServerDisconnected("Connection unexpectedly closed")\nsmtplib.SMTPServerDisconnected: Connection unexpectedly closed'))
        events.sort(key=lambda e: e[0])
        out = []
        first_seen = {}
        counts = {}
        warns = []
        first_err_sec = None
        for sec, level, msg in events:
            ts = _ts(base, sec)
            line = '%s [%s] %s %s' % (ts, level, svc, msg)
            out.append(line)
            if level == 'ERROR':
                code = msg.split()[0]
                counts[code] = counts.get(code, 0) + 1
                if code not in first_seen:
                    first_seen[code] = ts
                if first_err_sec is None:
                    first_err_sec = sec
        if svc == 'db-proxy':
            # 从实际写出的行算 truth(按行内时间戳),不按消息文本回查——重复的消息会取错行。
            first_err_line = next(l for l in out if ' [ERROR] ' in l)
            t_err = _parse(first_err_line)
            for l in out:
                if ' [WARN] ' in l and t_err - 60 <= _parse(l) < t_err:
                    truth['warns'].append(l)
            truth['warns'] = [l for l in truth['warns'] if out.index(l) < out.index(first_err_line)]
        for code in sorted(counts):
            truth['rows'].append({'service': svc, 'code': code, 'count': counts[code], 'first_seen': first_seen[code]})
        if counts:
            truth['affected'] += 1
        logs[svc] = '\n'.join(out) + '\n'
    truth['rows'].sort(key=lambda r: (r['service'], r['code']))
    return logs, truth

def _parse(line):
    ts = line.split(' [')[0]
    h, m, rest = ts.split(' ')[1].split(':')
    return int(h) * 3600 + int(m) * 60 + float(rest)

def setup(root):
    os.makedirs(os.path.join(root, 'logs'), exist_ok=True)
    logs, truth = generate()
    for svc, text in logs.items():
        with open(os.path.join(root, 'logs', svc + '.log'), 'w') as f:
            f.write(text)
    with open(os.path.join(root, 'README.md'), 'w') as f:
        f.write('# checkout incident 2026-09-04\n\nLogs for the 14:00–15:00 window are under logs/, one file per service.\nLine format: `<timestamp> [<LEVEL>] <service> <message>`; ERROR messages start with the error code (E-...).\n')
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True)
    with open(os.path.join(root, '.truth', 'f1.json'), 'w') as f:
        json.dump(truth, f, indent=1)
