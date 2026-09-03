"""oracle: the environment probe's expected end state, derived from the
workspace itself (probe script output, grep hit, glob count, line count)."""
import glob
import os
import subprocess
import sys


def solve(root):
    ans = os.path.join(root, "answers")
    os.makedirs(ans, exist_ok=True)
    probe = subprocess.run([sys.executable, "tools_probe.py"], cwd=root, capture_output=True, text=True, timeout=30)
    open(os.path.join(ans, "probe.md"), "w").write(probe.stdout.strip() + "\n")
    hits = sorted(os.path.basename(p) for p in glob.glob(os.path.join(root, "data", "*"))
                  if "needle-xq91" in open(p, encoding="utf-8", errors="replace").read())
    open(os.path.join(ans, "grep.md"), "w").write("\n".join(hits) + "\n")
    open(os.path.join(ans, "glob.md"), "w").write("%d\n" % len(glob.glob(os.path.join(root, "*.cfg"))))
    a = os.path.join(root, "a.cfg")
    open(a, "w").write(open(a).read().replace("alpha=1", "alpha=2", 1))
    n = open(os.path.join(root, "data", "file3.txt"), encoding="utf-8").read().count("\n")
    open(os.path.join(ans, "lines.md"), "w").write("%d\n" % n)
