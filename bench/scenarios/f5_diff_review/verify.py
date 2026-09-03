import os, json
def verify(root):
    t = json.load(open(os.path.join(root, '.truth', 'f5.json'))); problems = []
    try: r = json.load(open(os.path.join(root, 'review.json')))
    except Exception as e: return False, 'review.json missing/unreadable: %s' % str(e)[:80]
    if r.get('files_changed') != t['files_changed']: problems.append('files_changed %s want %s' % (r.get('files_changed'), t['files_changed']))
    if sorted(r.get('deleted_files') or []) != t['deleted_files']: problems.append('deleted_files %s' % r.get('deleted_files'))
    got = sorted(r.get('signature_changes') or []); want = t['signature_changes']
    if got != want: problems.append('signature_changes: %d/%d right, %d extra' % (len(set(got) & set(want)), len(want), len(set(got) - set(want))))
    if r.get('todos_added') != t['todos_added']: problems.append('todos_added %s want %s' % (r.get('todos_added'), t['todos_added']))
    if sorted(r.get('config_keys_changed') or []) != t['config_keys_changed']: problems.append('config_keys_changed %s' % r.get('config_keys_changed'))
    try:
        b = json.load(open(os.path.join(root, 'biggest.json')))
        if b.get('path') != t['biggest']['path'] or b.get('changed_lines') != t['biggest']['changed_lines']: problems.append('biggest %s want %s' % (b, t['biggest']))
    except Exception: problems.append('biggest.json missing/unreadable')
    ok = not problems
    return ok, ('review exact (%d files, %d signature changes, %d todos) + biggest' % (t['files_changed'], len(t['signature_changes']), t['todos_added']) if ok else '; '.join(problems)[:400])
