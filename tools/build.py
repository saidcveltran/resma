"""Build the static site into dist/.

Usage (from the repository root):  python -I tools/build.py

Standard library only. The build is deterministic: the same inputs give the same build id, the same
files and the same dist/build-manifest.json. Everything is computed in memory first; dist/ is written
only when every check has passed.

Exit codes: 0 ok, 1 build failure (vendor hash, budget, template, headers limits), 2 environment
failure (Node major, missing package-lock.json, unreadable configuration).
"""
import gzip
import hashlib
import html
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The only placeholders a page or partial may contain. Nothing is evaluated.
VALUE_NAMES = ("base_url", "version", "build_id", "assets_path", "route", "canonical_url",
               "title", "description", "h1")
PARTIAL_RE = re.compile(r"\{\{partial:([a-z0-9-]+)\}\}")
VALUE_RE = re.compile(r"\{\{([a-z0-9_]+)\}\}")
ANY_BRACES_RE = re.compile(r"\{\{.*?\}\}", re.S)
DOLLAR_RE = re.compile(r"\$\{[^}]*\}?")
SOURCEMAP_RE = re.compile(rb"\r?\n?//# sourceMappingURL=[^\r\n]*\s*\Z")
SOURCEMAP_ANY_RE = re.compile(rb"^//# sourceMappingURL=", re.M)
ROUTE_RE = re.compile(r"^/(?:[a-z0-9-]+/)*$")
FORBIDDEN_OUTPUT = ("_worker.js", "_routes.json")

EXIT_FAIL = 1
EXIT_ENV = 2

CACHE_REVALIDATE = "max-age=0, must-revalidate"
CACHE_IMMUTABLE = "max-age=31536000, immutable"
CACHE_BASE = "public, no-transform"
MAX_RULES = 100
MAX_LINE = 2000

CSP_BASE = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; "
            "font-src 'self'; worker-src 'self'; manifest-src 'self'; connect-src 'none'; "
            "object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; "
            "frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types resma-worker; "
            "upgrade-insecure-requests")
PERMISSIONS = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()"


class BuildError(Exception):
    def __init__(self, message, code=EXIT_FAIL):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------- helpers

def sha256(data):
    return hashlib.sha256(data).hexdigest()


def gzip_size(data):
    return len(gzip.compress(data, compresslevel=9, mtime=0))


def read_json(path, what):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise BuildError(f"cannot read {what} ({path.name}): {exc}", EXIT_ENV)


# ---------------------------------------------------------------- environment and vendor

def check_environment(root, site):
    """Node major (from site.json only) and the lockfile. Raises BuildError with exit code 2."""
    want = site.get("node_major")
    if not isinstance(want, int) or isinstance(want, bool):
        raise BuildError("environment check failed: site.json needs an integer node_major", EXIT_ENV)
    node = shutil.which("node")
    if not node:
        raise BuildError("environment check failed: node not found on PATH", EXIT_ENV)
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        raise BuildError(f"environment check failed: node --version: {exc}", EXIT_ENV)
    m = re.fullmatch(r"v(\d+)\.\d+\.\d+", out)
    if not m:
        raise BuildError(f"environment check failed: unexpected node version {out!r}", EXIT_ENV)
    if int(m.group(1)) != want:
        raise BuildError(f"environment check failed: node major {m.group(1)}, site.json requires {want}",
                         EXIT_ENV)
    if not (root / "package-lock.json").is_file():
        raise BuildError("environment check failed: package-lock.json is missing", EXIT_ENV)


def strip_source_map(upstream):
    """Remove the trailing sourceMappingURL comment; the result ends with one newline."""
    if not SOURCEMAP_RE.search(upstream):
        shipped = upstream
    else:
        shipped = SOURCEMAP_RE.sub(b"", upstream) + b"\n"
    if SOURCEMAP_ANY_RE.search(shipped):
        raise BuildError("vendor file still carries a sourceMappingURL comment after the strip")
    return shipped


def load_vendor(root):
    vendor = read_json(root / "vendor.json", "vendor.json")
    for key in ("path", "sha256", "shipped_sha256"):
        if not isinstance(vendor.get(key), str):
            raise BuildError(f"vendor.json lacks {key}", EXIT_ENV)
    path = root / vendor["path"]
    try:
        upstream = path.read_bytes()
    except OSError as exc:
        raise BuildError(f"vendor hash mismatch: cannot read {vendor['path']}: {exc}")
    if sha256(upstream) != vendor["sha256"]:
        raise BuildError(f"vendor hash mismatch: {vendor['path']} is {sha256(upstream)}, "
                         f"vendor.json upstream sha256 is {vendor['sha256']}")
    shipped = strip_source_map(upstream)
    if sha256(shipped) != vendor["shipped_sha256"]:
        raise BuildError(f"vendor hash mismatch: shipped file is {sha256(shipped)}, "
                         f"vendor.json shipped_sha256 is {vendor['shipped_sha256']}")
    return shipped


# ---------------------------------------------------------------- site.json

def load_site(root):
    site = read_json(root / "site.json", "site.json")
    for key in ("base_url", "version", "routes", "budget"):
        if key not in site:
            raise BuildError(f"site.json lacks {key}", EXIT_ENV)
    if not re.fullmatch(r"https://[a-z0-9.-]+", site["base_url"]):
        raise BuildError("site.json base_url must be an https origin without a path", EXIT_ENV)
    seen = set()
    for r in site["routes"]:
        for key in ("path", "page", "title", "description", "h1", "in_sitemap", "cache"):
            if key not in r:
                raise BuildError(f"site.json route {r.get('path', '?')} lacks {key}", EXIT_ENV)
        if not ROUTE_RE.match(r["path"]):
            raise BuildError(f"site.json route path {r['path']!r} is not a clean /segment/ path", EXIT_ENV)
        if r["path"] in seen:
            raise BuildError(f"site.json route {r['path']} is duplicated", EXIT_ENV)
        if r["cache"] != "revalidate":
            raise BuildError(f"site.json route {r['path']}: unknown cache class {r['cache']!r}", EXIT_ENV)
        if not re.fullmatch(r"[a-z0-9-]+", r["page"]):
            raise BuildError(f"site.json route {r['path']}: bad page name {r['page']!r}", EXIT_ENV)
        seen.add(r["path"])
    return site


# ---------------------------------------------------------------- rendering (no evaluation)

def read_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


TOKEN_RE = re.compile(r"\{\{(?:partial:([a-z0-9-]+)|([a-z0-9_]+))\}\}")


def validate(source, label, partials, allow_partials):
    """Fail on anything that is not a whitelisted token. Nothing is evaluated."""
    m = DOLLAR_RE.search(source)
    if m:
        raise BuildError(f"{label}: unknown placeholder {m.group(0)!r} (no ${{...}} expressions are allowed)")
    for m in ANY_BRACES_RE.finditer(source):
        t = TOKEN_RE.fullmatch(m.group(0))
        if t and t.group(1) is not None and allow_partials and t.group(1) in partials:
            continue
        if t and t.group(2) is not None and t.group(2) in VALUE_NAMES:
            continue
        raise BuildError(f"{label}: unknown placeholder {m.group(0)!r}")
    if source.count("{{") != len(ANY_BRACES_RE.findall(source)):
        raise BuildError(f"{label}: unknown placeholder (unclosed '{{{{')")


def render(source, label, partials, values):
    """Expand {{partial:name}} and {{name}} in one pass each; values are HTML-escaped."""
    validate(source, label, partials, True)
    expanded = PARTIAL_RE.sub(lambda m: partials[m.group(1)], source)
    return VALUE_RE.sub(lambda m: html.escape(values[m.group(1)], quote=True), expanded)


# ---------------------------------------------------------------- headers

def generate_headers(base_url, routes, root_files):
    """Return the text of dist/_headers (DESIGN section 7). routes/root_files are URL paths."""
    rules = []

    def rule(pattern, lines):
        rules.append((pattern, lines))

    rule("/*", [
        f"Content-Security-Policy: {CSP_BASE}",
        f"Cache-Control: {CACHE_BASE}",
        "Strict-Transport-Security: max-age=63072000; includeSubDomains",
        "X-Content-Type-Options: nosniff",
        "Referrer-Policy: no-referrer",
        f"Permissions-Policy: {PERMISSIONS}",
        "Cross-Origin-Opener-Policy: same-origin",
        "Cross-Origin-Resource-Policy: same-origin",
        "X-Frame-Options: DENY",
        "! Access-Control-Allow-Origin",
    ])
    rule(f"{base_url}/*", [
        f"Content-Security-Policy: script-src {base_url}/assets/; worker-src {base_url}/assets/",
    ])
    rule("/assets/*", [f"Cache-Control: {CACHE_IMMUTABLE}"])
    for path in list(routes) + list(root_files):
        rule(path, [f"Cache-Control: {CACHE_REVALIDATE}"])
    rule("https://:project.pages.dev/*", ["X-Robots-Tag: noindex"])
    rule("https://:version.:project.pages.dev/*", ["X-Robots-Tag: noindex"])

    if len(rules) > MAX_RULES:
        raise BuildError(f"_headers has {len(rules)} rules, the Pages limit is {MAX_RULES}")
    out = []
    for pattern, lines in rules:
        for line in [pattern] + ["  " + x for x in lines]:
            if len(line) > MAX_LINE:
                raise BuildError(f"_headers line of {len(line)} characters exceeds the Pages limit "
                                 f"of {MAX_LINE}: {line[:40]}...")
        out.append(pattern)
        out.extend("  " + x for x in lines)
        out.append("")
    text = "\n".join(out)
    lowered = text.lower()
    for word in ("report-uri", "report-to", "reporting-endpoints"):
        if word in lowered:
            raise BuildError(f"_headers must not contain {word}")
    return text


# ---------------------------------------------------------------- build

def build_id_of(assets, vendor):
    h = hashlib.sha256()
    for rel in sorted(assets):
        h.update(rel.encode("utf-8") + b"\0" + sha256(assets[rel]).encode("ascii") + b"\0")
    h.update(b"vendor\0" + sha256(vendor).encode("ascii"))
    return h.hexdigest()[:12]


def collect(directory):
    files = {}
    if directory.is_dir():
        for p in sorted(directory.rglob("*")):
            if p.is_file():
                files[p.relative_to(directory).as_posix()] = p.read_bytes()
    return files


def check_budget(site, files, assets_prefix, pages):
    """Return the report lines; raise BuildError on any breach (DESIGN 5.4)."""
    b = site["budget"]
    kb = 1024
    report, failures = [], []

    def check(name, size, limit, rule):
        ok = size <= limit
        line = f"{'ok  ' if ok else 'FAIL'} {name}: gzip {size} B, budget {limit} B ({rule})"
        report.append(line)
        if not ok:
            failures.append(line)

    gz = {p: gzip_size(d) for p, d in files.items()}
    css = sum(s for p, s in gz.items() if p.startswith(assets_prefix) and p.endswith(".css"))
    js = sum(s for p, s in gz.items()
             if p.startswith(assets_prefix) and p.endswith(".js") and "/vendor/" not in p)
    check("css total", css, b["css_gzip_kb"] * kb, "5.4 CSS")
    check("app js total", js, b["js_gzip_kb"] * kb, "5.4 App JS")
    check("engine (vendor)", gz[f"{assets_prefix}vendor/pdf-lib.esm.min.js"], b["engine_gzip_kb"] * kb,
          "5.4 Engine")
    fonts = [p for p in files if p.startswith(assets_prefix) and p.endswith(".woff2")]
    fsize = sum(len(files[p]) for p in fonts)
    ok = len(fonts) <= b["fonts_max_files"] and fsize <= b["fonts_total_kb"] * kb
    line = (f"{'ok  ' if ok else 'FAIL'} fonts: {len(fonts)} files, {fsize} B, budget "
            f"{b['fonts_max_files']} files / {b['fonts_total_kb'] * kb} B (5.4 Fonts)")
    report.append(line)
    if not ok:
        failures.append(line)
    for path in pages:
        check(path, gz[path], b["html_gzip_kb"] * kb, "5.4 HTML per page")
        check(f"{path} first view", gz[path] + css + js, b["first_view_gzip_kb"] * kb,
              "5.4 first view, HTML+CSS+app JS")
    return report, failures


def build(root):
    site = load_site(root)
    check_environment(root, site)
    vendor = load_vendor(root)

    assets = collect(root / "src" / "assets")
    build_id = build_id_of(assets, vendor)
    assets_prefix = f"assets/{build_id}/"

    files = {}
    for rel, data in assets.items():
        files[assets_prefix + rel] = data
    files[assets_prefix + "vendor/pdf-lib.esm.min.js"] = vendor

    partials = {}
    pdir = root / "src" / "partials"
    if pdir.is_dir():
        for p in sorted(pdir.glob("*.html")):
            partials[p.stem] = read_text(p)
    for name, text in partials.items():
        validate(text, f"partial {name}", partials, False)

    pages = []
    for r in site["routes"]:
        src = root / "src" / "pages" / f"{r['page']}.html"
        if not src.is_file():
            raise BuildError(f"route {r['path']}: missing src/pages/{r['page']}.html")
        values = {
            "base_url": site["base_url"], "version": site["version"], "build_id": build_id,
            "assets_path": "/" + assets_prefix.rstrip("/"), "route": r["path"],
            "canonical_url": site["base_url"] + r["path"], "title": r["title"],
            "description": r["description"], "h1": r["h1"],
        }
        out = render(read_text(src), f"page {r['page']}", partials, values)
        rel = r["path"].lstrip("/") + "index.html"
        files[rel] = out.encode("utf-8")
        pages.append(rel)

    static = collect(root / "static")
    root_files = []
    for rel, data in static.items():
        base = rel.rsplit("/", 1)[-1]
        if base.endswith(".map") or base in FORBIDDEN_OUTPUT or rel.split("/")[0] == "functions":
            raise BuildError(f"static/{rel} must not be shipped (SA-12)")
        files[rel] = data
        if "/" not in rel:
            root_files.append("/" + rel)

    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for r in site["routes"]:
        if r["in_sitemap"]:
            sitemap.append(f"  <url><loc>{html.escape(site['base_url'] + r['path'])}</loc></url>")
    sitemap.append("</urlset>")
    if "sitemap.xml" not in files:
        files["sitemap.xml"] = ("\n".join(sitemap) + "\n").encode("utf-8")
        root_files.append("/sitemap.xml")
    for name in site.get("verification_files", []):
        if name not in static:
            raise BuildError(f"site.json verification file {name} is not in static/")

    headers = generate_headers(site["base_url"], [r["path"] for r in site["routes"]], sorted(root_files))
    files["_headers"] = headers.encode("utf-8")

    report, failures = check_budget(site, files, assets_prefix, pages)
    if failures:
        raise BuildError("size budget exceeded:\n" + "\n".join(failures))

    manifest = {"build_id": build_id, "version": site["version"],
                "files": [{"path": p, "bytes": len(d), "gzip_bytes": gzip_size(d), "sha256": sha256(d)}
                          for p, d in sorted(files.items())]}
    files["build-manifest.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
    return build_id, files, report


def write_dist(root, files):
    dist = root / "dist"
    if dist.exists():
        if dist.resolve().parent != root.resolve():
            raise BuildError("refusing to clear a dist path outside the repository", EXIT_ENV)
        shutil.rmtree(dist)
    for rel, data in files.items():
        target = dist / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def main():
    try:
        build_id, files, report = build(ROOT)
        write_dist(ROOT, files)
    except BuildError as exc:
        print(f"build failed: {exc}", file=sys.stderr)
        return exc.code
    for line in report:
        print(line)
    print(f"build id {build_id}")
    print(f"wrote {len(files)} files to dist/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
