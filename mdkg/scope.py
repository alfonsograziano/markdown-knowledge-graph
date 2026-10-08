"""Which files are read, and how each one is cut into Graphiti episodes."""

import fnmatch
import hashlib
import re
import tomllib
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

import yaml

from .config import SOURCE_ROOT, PROJECT_DIR

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n?", re.DOTALL)


@dataclass(frozen=True)
class Scope:
    include: list[str]
    extensions: list[str]
    max_words: int
    deny_paths: list[str]
    deny_suffixes: list[str]

    def denied(self, rel: str) -> bool:
        """A deny entry is a glob when it has a *, an exact file when it ends in .md,
        and otherwise a folder prefix from the source root."""
        for entry in self.deny_paths:
            if "*" in entry:
                if fnmatch.fnmatch(rel, entry):
                    return True
            elif entry.endswith(".md"):
                if rel == entry:
                    return True
            elif rel.startswith(entry if entry.endswith("/") else entry + "/"):
                return True
        return any(rel.endswith(s) for s in self.deny_suffixes)


@dataclass
class Doc:
    path: str  # relative to the source root
    meta: dict
    body: str

    @property
    def doc_type(self) -> str | None:
        """The `type` field from the frontmatter, if the file has one."""
        value = self.meta.get("type")
        return str(value) if value else None

    @property
    def title(self) -> str:
        if self.meta.get("title"):
            return str(self.meta["title"])
        heading = re.search(r"^# (.+)$", self.body, re.MULTILINE)
        return heading[1].strip() if heading else Path(self.path).stem

    @property
    def reference_time(self) -> datetime:
        for key in ("updated", "created", "date"):
            value = self.meta.get(key)
            if isinstance(value, date):
                return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
        mtime = (SOURCE_ROOT / self.path).stat().st_mtime
        return datetime.fromtimestamp(mtime, tz=timezone.utc)


@dataclass
class Episode:
    name: str  # "<path>#<n>", unique and stable
    doc: Doc
    text: str

    @property
    def words(self) -> int:
        return len(self.text.split())

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.text.encode()).hexdigest()


def load_scope(path: Path = PROJECT_DIR / "scope.toml") -> Scope:
    raw = tomllib.loads(path.read_text())
    return Scope(
        include=[p.strip("/") for p in raw["scope"]["include"]],
        extensions=raw["scope"].get("extensions", [".md"]),
        max_words=int(raw["scope"].get("max_words_per_episode", 1200)),
        deny_paths=list(raw["deny"].get("paths", [])),
        deny_suffixes=raw["deny"].get("suffixes", []),
    )


def read_doc(rel: str) -> Doc:
    text = (SOURCE_ROOT / rel).read_text(encoding="utf-8")
    meta, body = {}, text
    m = FRONTMATTER.match(text)
    if m:
        try:
            meta = yaml.safe_load(m[1]) or {}
        except yaml.YAMLError:
            meta = {}
        body = text[m.end():]
    return Doc(path=rel, meta=meta if isinstance(meta, dict) else {}, body=body)


def docs_in_scope(scope: Scope) -> list[Doc]:
    """Every allowed file under the include paths, minus denied and private ones."""
    seen: dict[str, None] = {}
    for inc in scope.include:
        base = SOURCE_ROOT / inc
        candidates = [base] if base.is_file() else sorted(base.rglob("*"))
        for f in candidates:
            if not f.is_file() or f.suffix not in scope.extensions:
                continue
            rel = f.relative_to(SOURCE_ROOT).as_posix()
            if scope.denied(rel):
                continue
            seen.setdefault(rel, None)
    docs = [read_doc(rel) for rel in seen]
    return [d for d in docs if d.meta.get("sensitivity") != "private"]


def _split_long(section: str, max_words: int) -> list[str]:
    if len(section.split()) <= max_words:
        return [section]
    parts, current = [], []
    for para in re.split(r"\n\s*\n", section):
        if current and len(" ".join(current).split()) + len(para.split()) > max_words:
            parts.append("\n\n".join(current))
            current = []
        current.append(para)
    if current:
        parts.append("\n\n".join(current))
    return parts


def episodes_for(doc: Doc, max_words: int) -> list[Episode]:
    """Cut a file at '## ' headings, merging small sections up to max_words."""
    sections = [s for s in re.split(r"(?m)^(?=## )", doc.body) if s.strip()]
    pieces: list[str] = []
    for section in sections:
        pieces.extend(_split_long(section.strip(), max_words))

    chunks, current = [], ""
    for piece in pieces:
        if current and len(current.split()) + len(piece.split()) > max_words:
            chunks.append(current)
            current = ""
        current = f"{current}\n\n{piece}" if current else piece
    if current:
        chunks.append(current)

    header = f"File: {doc.path}\nTitle: {doc.title}"
    if doc.doc_type:
        header += f"\nType: {doc.doc_type}"
        if doc.meta.get("status"):
            header += f"\nStatus: {doc.meta['status']}"
    return [
        Episode(name=f"{doc.path}#{i}", doc=doc, text=f"{header}\n\n{chunk}")
        for i, chunk in enumerate(chunks or [""])
    ]
