import os, json
def solve(root):
    t = json.load(open(os.path.join(root, '.truth', 'f5.json')))
    json.dump({k: t[k] for k in ('files_changed', 'deleted_files', 'signature_changes', 'todos_added', 'config_keys_changed')}, open(os.path.join(root, 'review.json'), 'w'))
    json.dump(t['biggest'], open(os.path.join(root, 'biggest.json'), 'w'))
