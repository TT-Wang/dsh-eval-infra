import os, json
def verify(root):
    t = json.load(open(os.path.join(root, '.truth', 'f9.json'))); problems = []
    try: a = json.load(open(os.path.join(root, 'answers.json')))
    except Exception as e: return False, 'answers.json missing/unreadable: %s' % str(e)[:60]
    for k in ('connect_timeout_default', 'max_batch_size', 'retry_backoff_default_ms', 'rate_limit_per_minute', 'error_code_insufficient_funds'):
        try:
            if int(a.get(k)) != t[k]: problems.append('%s=%s want %s' % (k, a.get(k), t[k]))
        except Exception: problems.append('%s unreadable' % k)
    if str(a.get('deprecated_in', '')).strip() != t['deprecated_in']: problems.append('deprecated_in=%s want %s' % (a.get('deprecated_in'), t['deprecated_in']))
    if sorted(a.get('required_fields_create_order') or []) != t['required_fields_create_order']: problems.append('required fields %s' % a.get('required_fields_create_order'))
    if str(a.get('webhook_signature_header', '')).strip().lower() != t['webhook_signature_header'].lower(): problems.append('header %s' % a.get('webhook_signature_header'))
    p = os.path.join(root, 'migration.txt')
    if not os.path.isfile(p): problems.append('migration.txt missing')
    else:
        s = open(p).read().lower()
        if not all(k in s for k in t['migration_sentence_keywords']): problems.append('migration sentence lacks %s' % t['migration_sentence_keywords'])
        if t['migration_url'].lower() not in s and 'guides/migration-3x' not in s: problems.append('migration url wrong')
    ok = not problems
    return ok, ('8 answers + migration exact' if ok else '; '.join(problems)[:400])
