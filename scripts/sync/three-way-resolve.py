#!/usr/bin/env python3
"""
three-way-resolve.py — rename-normalized 3-way merge for upstream syncs.

For every conflicted file in a sync merge, the naive resolution
(take upstream + codemod) is only valid when the fork's delta on that
file is a *pure rename*. Where the fork added real feature code, this
script performs a proper 3-way merge with the rename normalized out:

    base'   = codemod(merge-base version)
    ours    = fork master version (has features, fork branding)
    theirs' = codemod(upstream version)
    merged  = git merge-file(ours, base', theirs')

Files whose fork delta IS a pure rename (ours == base') keep the
already-applied theirs' resolution. Genuine feature-vs-upstream
collisions come back as conflict markers listed for manual resolution.

Usage: python3 scripts/sync/three-way-resolve.py <conflicts-list-file> \
           <base-ref> <ours-ref> <theirs-ref>
e.g.:  ... /tmp/conflicts.txt $(git merge-base master upstream/master) \
           master upstream/master
"""
import importlib.util
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(".").resolve()
spec = importlib.util.spec_from_file_location(
    "codemod", ROOT / "scripts" / "sync" / "rebrand-codemod.py")
codemod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codemod)


def show(ref, path):
    r = subprocess.run(["git", "cat-file", "-p", f"{ref}:{path}"],
                       capture_output=True)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None


def main():
    listfile, base_ref, ours_ref, theirs_ref = sys.argv[1:5]
    files = [l.strip() for l in open(listfile) if l.strip()]
    pure, merged_clean, conflicted, skipped = [], [], [], []
    for f in files:
        base = show(base_ref, f)
        ours = show(ours_ref, f)
        theirs = show(theirs_ref, f)
        if base is None or ours is None or theirs is None:
            skipped.append(f)   # add/delete cases — already resolved
            continue
        base_n, _ = codemod.transform(base, f)
        theirs_n, _ = codemod.transform(theirs, f)
        if ours == base_n:
            pure.append(f)      # fork delta was pure rename; theirs' stands
            continue
        with tempfile.TemporaryDirectory() as td:
            td = pathlib.Path(td)
            (td / "ours").write_text(ours, encoding="utf-8")
            (td / "base").write_text(base_n, encoding="utf-8")
            (td / "theirs").write_text(theirs_n, encoding="utf-8")
            r = subprocess.run(
                ["git", "merge-file", "-p",
                 "-L", "FORK (ours)", "-L", "BASE", "-L", "UPSTREAM",
                 str(td / "ours"), str(td / "base"), str(td / "theirs")],
                capture_output=True)
            out = r.stdout.decode("utf-8", "replace")
        target = ROOT / f
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(out, encoding="utf-8")
        if r.returncode == 0:
            merged_clean.append(f)
        else:
            conflicted.append(f)
    print(f"pure-rename (theirs' kept): {len(pure)}")
    print(f"3-way merged clean (fork features restored): {len(merged_clean)}")
    for f in merged_clean:
        print(f"  M {f}")
    print(f"REAL CONFLICTS needing manual resolution: {len(conflicted)}")
    for f in conflicted:
        print(f"  C {f}")
    print(f"skipped (add/delete): {len(skipped)}")
    pathlib.Path("scripts/sync/sync-conflicts.txt").write_text(
        "\n".join(conflicted) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
