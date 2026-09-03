import os, random, json
SEED = 20260904
TRUTH = {'connect_timeout_default': 45, 'max_batch_size': 250, 'retry_backoff_default_ms': 800, 'deprecated_in': '3.4.0',
         'required_fields_create_order': ['currency', 'customer_id', 'idempotency_key', 'line_items'], 'rate_limit_per_minute': 1200,
         'webhook_signature_header': 'X-Meridian-Signature', 'error_code_insufficient_funds': 4021,
         'migration_sentence_keywords': ['resumes', 'checkpoint'], 'migration_url': 'https://docs.example.com/guides/migration-3x'}
WORDS = 'the client request response payload stream buffer session handler retry policy region tenant schema field value option default limit token header cursor page batch event webhook signature ledger balance transfer settlement dispute audit'.split()
def prose(r, n_par, topic):
    out = []
    for p in range(n_par):
        sent = []
        for s in range(r.randint(4, 8)):
            k = r.randint(8, 18)
            sent.append(' '.join(r.choice(WORDS) for _ in range(k)).capitalize() + ' in the context of %s.' % topic)
        out.append(' '.join(sent))
    return '\n\n'.join(out)
def table(rows):
    return '<table><tr><th>name</th><th>type</th><th>default</th><th>description</th></tr>' + ''.join('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % row for row in rows) + '</table>'
def page(title, body_parts):
    return '<html><head><title>%s</title></head><body><nav>Meridian SDK docs · <a href="/">index</a></nav>\n<h1>%s</h1>\n%s\n<footer>© Meridian · generated docs</footer></body></html>' % (title, title, '\n'.join(body_parts))
def setup(root):
    r = random.Random(SEED)
    site = os.path.join(root, 'site'); os.makedirs(os.path.join(site, 'api'), exist_ok=True); os.makedirs(os.path.join(site, 'guides'), exist_ok=True); os.makedirs(os.path.join(site, 'reference'), exist_ok=True)
    pages = {}
    api_pages = ['client', 'orders', 'customers', 'payments', 'refunds', 'webhooks', 'events', 'batches', 'ledger', 'reports', 'auth', 'errors', 'rate-limits', 'search', 'exports', 'imports', 'settlements', 'disputes', 'balances', 'transfers']
    for name in api_pages:
        parts = ['<p>%s</p>' % prose(r, 3, name)]
        rows = [(f, r.choice(['string', 'integer', 'boolean', 'object']), r.choice(['—', '0', 'null', 'false']), prose(r, 1, f)[:120]) for f in ['id', 'created_at', 'metadata', 'status', 'region', 'tenant_id', 'cursor', 'limit']]
        if name == 'client':
            rows += [('connect_timeout', 'integer (seconds)', str(TRUTH['connect_timeout_default']), 'Seconds to wait for the initial connection before failing.'), ('read_timeout', 'integer (seconds)', '120', 'Seconds to wait for a response.')]
            parts.append('<h2>Configuration</h2>' + table(rows))
            parts.append('<h2>Deprecations</h2><p>%s</p><ul><li><code>Client.sync_all</code> — deprecated in %s, use <code>Client.sync(scope)</code> instead.</li><li><code>Client.legacy_auth</code> — deprecated in 2.9.0.</li></ul>' % (prose(r, 1, 'deprecation'), TRUTH['deprecated_in']))
        elif name == 'batches':
            rows += [('max_batch_size', 'integer', str(TRUTH['max_batch_size']), 'Maximum number of items per batch request.')]
            parts.append('<h2>Limits</h2>' + table(rows))
        elif name == 'orders':
            parts.append('<h2>POST /v2/orders — create order</h2><p>%s</p>' % prose(r, 2, 'orders'))
            req = [('customer_id', 'string', 'required', 'Customer to bill.'), ('line_items', 'array', 'required', 'At least one item.'), ('currency', 'string', 'required', 'ISO 4217 code.'), ('idempotency_key', 'string', 'required', 'Unique per request.'), ('notes', 'string', 'optional', 'Free text.'), ('metadata', 'object', 'optional', 'Key/value pairs.'), ('coupon', 'string', 'optional', 'Promotion code.')]
            parts.append('<h3>Request fields</h3>' + table(req))
        elif name == 'rate-limits':
            rows += [('requests_per_minute', 'integer', str(TRUTH['rate_limit_per_minute']), 'Per API key, sliding window.'), ('burst', 'integer', '50', 'Burst allowance.')]
            parts.append('<h2>Limits</h2>' + table(rows))
        elif name == 'webhooks':
            parts.append('<h2>Verifying signatures</h2><p>Every delivery carries the header <code>%s</code> with an HMAC-SHA256 of the raw body. %s</p>' % (TRUTH['webhook_signature_header'], prose(r, 1, 'signatures')))
        elif name == 'errors':
            codes = [(str(4000 + i), 'error_%d' % i, r.choice(['400', '402', '409', '422', '429']), prose(r, 1, 'error')[:90]) for i in range(1, 40)]
            codes.insert(21, (str(TRUTH['error_code_insufficient_funds']), 'insufficient_funds', '402', 'The account balance cannot cover the requested amount.'))
            parts.append('<h2>Error codes</h2>' + table(codes))
        elif name == 'client-retry' or name == 'auth':
            pass
        parts.append('<h2>Retry policy</h2><p>%s</p>' % prose(r, 2, 'retries'))
        if name == 'client':
            parts.append('<h3>Retry defaults</h3>' + table([('retry_max_attempts', 'integer', '5', 'Attempts before giving up.'), ('retry_backoff_ms', 'integer', str(TRUTH['retry_backoff_default_ms']), 'Initial backoff, doubled per attempt.'), ('retry_jitter', 'boolean', 'true', 'Randomise backoff.')]))
        parts.append('<h2>Examples</h2><pre>' + '\n'.join('curl -X GET https://api.example.com/v2/%s?page=%d' % (name, i) for i in range(1, 6)) + '</pre>')
        parts.append('<h2>Changelog</h2><ul>' + ''.join('<li>%s — %s</li>' % (v, prose(r, 1, 'changelog')[:140]) for v in ['3.6.0', '3.5.2', '3.5.0', '3.4.1', '3.4.0', '3.3.0', '3.2.1', '3.1.0']) + '</ul>')
        parts.append('<p>%s</p>' % prose(r, 6, name + ' internals'))
        pages['api/%s.html' % name] = page('API: %s' % name, parts)
    # guides
    guides = ['quickstart', 'authentication', 'pagination', 'idempotency', 'testing', 'migration-3x', 'migration-2x', 'observability', 'security', 'sandbox']
    for g in guides:
        parts = ['<p>%s</p>' % prose(r, 8, g)]
        if g == 'migration-3x':
            parts.append('<h2>Connection loss during a batch</h2><p>In 2.x a batch whose connection dropped half-way was abandoned and had to be resubmitted from scratch. In 3.x the client resumes the batch from the last acknowledged checkpoint after reconnecting, so already-accepted items are not sent twice. %s</p>' % prose(r, 1, 'resume'))
        parts.append('<p>%s</p>' % prose(r, 6, g + ' details'))
        pages['guides/%s.html' % g] = page('Guide: %s' % g, parts)
    for i in range(30):
        pages['reference/topic-%02d.html' % i] = page('Reference topic %d' % i, ['<p>%s</p>' % prose(r, 12, 'topic %d' % i)])
    index = '<h2>Sections</h2><ul>' + ''.join('<li><a href="https://docs.example.com/%s">%s</a></li>' % (p[:-5], p[:-5]) for p in sorted(pages)) + '</ul>'
    pages['index.html'] = page('Meridian SDK documentation', ['<p>All pages are listed below. API reference pages carry configuration and limit tables; guides carry narrative.</p>', index])
    for rel, html in pages.items():
        p = os.path.join(site, rel); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, 'w').write(html)
    os.makedirs(os.path.join(root, '.truth'), exist_ok=True); json.dump(TRUTH, open(os.path.join(root, '.truth', 'f9.json'), 'w'))
    open(os.path.join(root, 'README.md'), 'w').write('# meridian integration\n\nDocs: https://docs.example.com/ (use the fetch_page tool).\n')
