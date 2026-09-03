"""m1_cross_session_recall workspace: a small repo with a STALE kickoff note (the
decoy) whose keys match the facts given in chat."""
import os

OLD = '''# Kickoff (2025 -- superseded, kept for history)
- project_code: KST-3902
- api_port: 8080
- db_host: db-02.internal
- tech_owner: Lena Holm
- product_owner: Marcus Oyelaran
- deadline: 2025-11-01
'''


def setup(root):
    os.makedirs(os.path.join(root, 'notes'), exist_ok=True)
    with open(os.path.join(root, 'notes', 'old_kickoff_2025.md'), 'w') as f:
        f.write(OLD)
    with open(os.path.join(root, 'README.md'), 'w') as f:
        f.write('# Kestrel-Sync\n\nProject notes live under notes/; scripts under scripts/.\n')
