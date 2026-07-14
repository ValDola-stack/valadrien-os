#!/usr/bin/env python3
"""
rebrand-codemod.py — Idempotent brand transform for upstream syncs.

Renames upstream brand tokens to the fork's brand across the tree.
SELF-SAFE: all brand tokens in this file are assembled at runtime
(never appear literally), so the codemod can never rewrite itself,
and scripts/sync/ is excluded from the walk anyway.

Usage:  python3 scripts/sync/rebrand-codemod.py [repo-root]

Renames (content):
  @<org>/<pkg>        -> @valadrien-os/<pkg>
  UPSTREAM_SNAKE_*    -> VALADRIEN_OS_*
  upstream_snake_*    -> valadrien_os_*
  upstreamCamelCase   -> valadrienOsCamelCase
  UpstreamCompound    -> ValadrienOsCompound
  upstream (bare lc)  -> valadrien-os

Deliberately KEPT (protected):
  hermes-<brand>-adapter    published third-party package name
  <brand>_required          legacy origin type value (compat)
  <org>/<brand> slug        upstream repo URLs / PR refs
  <org> bare                upstream org references
  <brand>s plural           flagged for review, not renamed
  Bare standalone Pascal brand word -> ValadrienOs (fork convention,
  incl. X-*-Run-Id header), EXCEPT lucide-react icon contexts
  (imports from lucide-react, <Icon JSX, `icon: Icon`), which are kept.

Renames (paths): any segment containing the lowercase brand word.
On collision the upstream-derived file wins (upstream is newer at sync).
"""
import os
import re
import sys
import pathlib

# ---- brand tokens, assembled so they never appear literally in this file --
B = "paper" + "clip"                  # upstream brand, lowercase
BP = B.capitalize()                    # Paperclip
BU = B.upper()                         # PAPERCLIP
ORG = B + "ai"                         # upstream npm/GitHub org
NEW_KEBAB = "valadrien-os"
NEW_SNAKE = "valadrien_os"
NEW_SCREAM = "VALADRIEN_OS"
NEW_CAMEL = "valadrienOs"
NEW_PASCAL = "ValadrienOs"

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
SELF_DIR = pathlib.Path(__file__).resolve().parent

EXCLUDE_DIRS = {".git", "node_modules", "dist", "build", ".pnpm-store",
                "releases", ".next", "coverage"}
# Fork-identity docs (top level only): hand-maintained, intentionally
# describe the rename — never auto-rewritten.
EXCLUDE_FILES = {"LICENSE", "pnpm-lock.yaml", "README.md", "AGENTS.md",
                 "DESIGN.md", "CONTRIBUTING.md", "Architecture.md", "PRD.md",
                 "ROADMAP.md"}
BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2",
              ".ttf", ".otf", ".eot", ".pdf", ".zip", ".gz", ".tar", ".jar",
              ".node", ".wasm", ".mp4", ".webm", ".patch"}

# protections (placeholder swap, restored after renames)
KEEP_HERMES = "hermes-" + B + "-adapter"
KEEP_REQUIRED = B + "_required"
KEEP_SLUG = ORG + "/" + B
KEEP_PLURAL = B + "s"
P_HERMES, P_REQ, P_SLUG, P_ORG, P_PLURAL = (
    "\x00H\x00", "\x00R\x00", "\x00S\x00", "\x00O\x00", "\x00P\x00")

RENAMES = [
    (re.compile(BU + "_"), NEW_SCREAM + "_"),
    (re.compile(B + "_"), NEW_SNAKE + "_"),
    (re.compile(B + r"(?=[A-Z])"), NEW_CAMEL),
    (re.compile(BP + r"(?=[A-Z0-9_])"), NEW_PASCAL),
    (re.compile(B), NEW_KEBAB),
]
BARE_PASCAL = re.compile(BP + r"(?![A-Za-z0-9_])")
# lucide icon contexts to protect from the bare-Pascal rename
LUCIDE_IMPORT = re.compile(
    r"import\s*(?:type\s*)?\{[^}]*\}\s*from\s*['\"]lucide-react['\"]",
    re.DOTALL)
JSX_ICON = re.compile(r"<" + BP + r"(?![A-Za-z0-9_])")
PROP_ICON = re.compile(r"([Ii]con\s*:\s*)" + BP + r"(?![A-Za-z0-9_])")
P_ICON = "\x00I\x00"

review_lines = []
changed_files = 0
flagged_files = 0


def transform(text: str, relpath: str):
    global flagged_files
    orig = text
    text = text.replace(KEEP_HERMES, P_HERMES)
    text = text.replace(KEEP_REQUIRED, P_REQ)
    text = text.replace("@" + ORG + "/", "@" + NEW_KEBAB + "/")
    text = text.replace(KEEP_SLUG, P_SLUG)
    text = text.replace(ORG, P_ORG)
    text = text.replace(KEEP_PLURAL, P_PLURAL)
    if P_PLURAL in text:
        review_lines.append(f"[plural '{KEEP_PLURAL}' kept] {relpath}")
    for rx, rep in RENAMES:
        text = rx.sub(rep, text)
    # bare Pascal brand word: protect lucide icon contexts, rename the rest
    def _protect_import(m):
        return m.group(0).replace(BP, P_ICON)
    text = LUCIDE_IMPORT.sub(_protect_import, text)
    text = JSX_ICON.sub("<" + P_ICON, text)
    text = PROP_ICON.sub(lambda m: m.group(1) + P_ICON, text)
    # if the file imports the icon from lucide, remaining bare identifiers
    # in that file are almost certainly the icon -> flag them, else rename
    hits = []
    if P_ICON in text:
        for i, line in enumerate(text.splitlines(), 1):
            if BARE_PASCAL.search(line):
                hits.append(f"  {relpath}:{i}: {line.strip()[:160]}")
    text = BARE_PASCAL.sub(NEW_PASCAL, text)
    text = text.replace(P_ICON, BP)
    if hits:
        flagged_files += 1
        review_lines.append(
            f"[bare '{BP}' renamed in a lucide-icon file — verify these "
            f"were display strings, not icon refs] {relpath}")
        review_lines.extend(hits[:20])
        if len(hits) > 20:
            review_lines.append(f"  ... {len(hits)-20} more lines")
    text = (text.replace(P_HERMES, KEEP_HERMES)
                .replace(P_REQ, KEEP_REQUIRED)
                .replace(P_SLUG, KEEP_SLUG)
                .replace(P_ORG, ORG)
                .replace(P_PLURAL, KEEP_PLURAL))
    return text, text != orig


def main():
    global changed_files
    marker = "aperclip"  # cheap containment check, never self-matching intent
    # ---- content pass ----
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        if pathlib.Path(dirpath).resolve() == SELF_DIR:
            continue
        for fn in filenames:
            p = pathlib.Path(dirpath) / fn
            rel = str(p.relative_to(ROOT))
            if fn in EXCLUDE_FILES and pathlib.Path(rel).parent == pathlib.Path("."):
                continue
            if p.suffix.lower() in BINARY_EXT:
                continue
            try:
                text = p.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            if marker not in text and marker.upper() not in text:
                continue
            new, did = transform(text, rel)
            if did:
                p.write_text(new, encoding="utf-8")
                changed_files += 1
    # ---- path pass (deepest first) ----
    moves = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        if pathlib.Path(dirpath).resolve() == SELF_DIR:
            continue
        for name in filenames + dirnames:
            if B in name and KEEP_HERMES not in name:
                moves.append(pathlib.Path(dirpath) / name)
    for src in sorted(moves, key=lambda x: len(str(x)), reverse=True):
        if not src.exists():
            continue
        dst = src.with_name(src.name.replace(B, NEW_KEBAB))
        if dst.exists():
            if src.is_dir():
                for child in list(src.rglob("*")):
                    tgt = dst / child.relative_to(src)
                    if child.is_file():
                        tgt.parent.mkdir(parents=True, exist_ok=True)
                        child.replace(tgt)
                for d in sorted(src.rglob("*"), reverse=True):
                    if d.is_dir():
                        d.rmdir()
                src.rmdir()
            else:
                src.replace(dst)
            review_lines.append(f"[path collision merged, upstream won] "
                                f"{src.relative_to(ROOT)} -> {dst.relative_to(ROOT)}")
        else:
            src.replace(dst)
    report = ROOT / "scripts" / "sync" / "sync-review.txt"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("\n".join(review_lines) + "\n", encoding="utf-8")
    print(f"codemod: {changed_files} files rewritten, "
          f"{flagged_files} files flagged for review, "
          f"{len(moves)} paths renamed")
    print(f"review report: {report.relative_to(ROOT)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"codemod ERROR: {e}", file=sys.stderr)
        sys.exit(2)
