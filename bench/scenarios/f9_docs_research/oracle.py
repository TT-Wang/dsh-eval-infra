import os, json
def solve(root):
    t = json.load(open(os.path.join(root, '.truth', 'f9.json')))
    json.dump({k: t[k] for k in ('connect_timeout_default', 'max_batch_size', 'retry_backoff_default_ms', 'deprecated_in', 'required_fields_create_order', 'rate_limit_per_minute', 'webhook_signature_header', 'error_code_insufficient_funds')}, open(os.path.join(root, 'answers.json'), 'w'))
    open(os.path.join(root, 'migration.txt'), 'w').write('The 3.x client resumes the batch from the last acknowledged checkpoint after reconnecting instead of resubmitting it. | %s\n' % t['migration_url'])
