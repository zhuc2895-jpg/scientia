from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit

CITATION_PATTERN = (
    r"https?://[^\s<>`\"']+"
    r"|doi:\s*10\.\d{4,9}/\S+"
    r"|DOI\s+10\.\d{4,9}/\S+"
    r"|\b10\.\d{4,9}/[^\s<>()]+"
    r"|\[[0-9]+(?:\s*[,–-]\s*[0-9]+)*\]"
    r"|\([A-Z][A-Za-z'’-]+(?:\s+(?:et al\.|and\s+[A-Z][A-Za-z'’-]+))?,\s*(?:19|20)\d{2}[a-z]?\)"
    r"|[A-Z][A-Za-z'’-]+(?:\s+et al\.)?\s+\((?:19|20)\d{2}[a-z]?\)"
    r"|\\(?:cite|citep|citet|parencite|textcite)\*?\s*(?:\[[^\]]*\]\s*)*\{[^}]+\}"
    r"|`[^`]+\.(?:pdf|md|csv|py|ipynb)`"
)
CITATION_RE = re.compile(CITATION_PATTERN, flags=re.IGNORECASE)
DOI_RE = re.compile(r"(?:doi:\s*|doi\.org/)?(10\.\d{4,9}/\S+)", flags=re.IGNORECASE)
NUMBER_RE = re.compile(r"\[([0-9]+(?:\s*[,–-]\s*[0-9]+)*)\]")
LATEX_RE = re.compile(
    r"\\(?:cite|citep|citet|parencite|textcite)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}",
    flags=re.IGNORECASE,
)
def _normalized_title(value: Any) -> str:
    return re.sub(r"[^\w]+", " ", str(value or "").lower()).strip()


def _normalized_url(value: Any) -> str | None:
    raw = str(value or "").strip()
    if not raw.lower().startswith(("http://", "https://")):
        return None
    parts = urlsplit(raw)
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def _doi(value: Any) -> str | None:
    match = DOI_RE.search(str(value or ""))
    return match.group(1).rstrip(").,;").lower() if match else None


def _source_allowed(source: dict[str, Any]) -> bool:
    return source.get("freshnessState") == "current" and source.get("verificationState") == "verified"


def _source_surnames(source: dict[str, Any]) -> set[str]:
    names = set()
    for author in source.get("authors") or []:
        value = str(author or "").strip()
        if not value:
            continue
        family = value.split(",", 1)[0] if "," in value else value.split()[-1]
        names.add(family.lower())
    return names


def _author_year_components(value: str) -> tuple[int | None, frozenset[str]]:
    year_match = re.search(r"\b((?:19|20)\d{2})[a-z]?\b", value)
    if not year_match:
        return None, frozenset()
    prefix = value[: year_match.start()]
    surnames = frozenset(
        token.lower()
        for token in re.findall(r"\b[A-Z][A-Za-z'’-]+\b", prefix)
        if token.lower() not in {"et", "al", "and"}
    )
    return int(year_match.group(1)), surnames


def _reference_matches_source(reference: str, source: dict[str, Any]) -> bool:
    if not _source_allowed(source):
        return False
    value = reference.strip().strip("'\"`").replace("\\", "/")
    lowered = value.lower()
    citation_year, citation_surnames = _author_year_components(value)
    if citation_year and citation_surnames:
        if source.get("year") != citation_year:
            return False
        return citation_surnames == frozenset(_source_surnames(source))

    source_url = _normalized_url(source.get("url"))
    source_doi = _doi(source.get("doi") or source.get("stableIdentifier"))
    reference_doi = _doi(lowered)
    if lowered.startswith(("http://", "https://")):
        lowered_url = _normalized_url(value)
        if source_url and lowered_url == source_url:
            return True
        return bool(reference_doi and source_doi and reference_doi == source_doi)
    if reference_doi:
        return bool(source_doi and reference_doi == source_doi)

    reference_path = lowered.split("#", 1)[0].rstrip("/")
    reference_basename = reference_path.rsplit("/", 1)[-1]
    for key in ("localLocator", "stableIdentifier", "citekey", "title"):
        candidate = str(source.get(key) or "").strip().replace("\\", "/")
        candidate_lower = candidate.lower().split("#", 1)[0].rstrip("/")
        if not candidate_lower:
            continue
        if reference_path == candidate_lower:
            return True
        if "/" not in reference_path and reference_basename == candidate_lower.rsplit("/", 1)[-1]:
            return True
    return False


def _matches_any_source(
    reference: str,
    sources: list[dict[str, Any]],
    evidence_entry: dict[str, Any] | None = None,
) -> bool:
    return any(
        _reference_matches_source(reference, source)
        and (evidence_entry is None or _evidence_survives_source_revision(evidence_entry, source))
        for source in sources
        if isinstance(source, dict)
    )


def _authorized_sources(
    reference: str,
    active_sources: list[dict[str, Any]],
    registered_sources: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    active = {
        _source_identity(source): source
        for source in active_sources
        if isinstance(source, dict) and _source_allowed(source) and _reference_matches_source(reference, source)
    }
    registered = {
        _source_identity(source): source
        for source in registered_sources
        if isinstance(source, dict) and _source_allowed(source) and _reference_matches_source(reference, source)
    }
    return [active[key] for key in active.keys() & registered.keys()]


def _normalize_claim(value: Any) -> str:
    normalized = re.sub(r"\s+", " ", str(value or "")).strip()
    return normalized.strip(".,;:!?").lower()


def _is_abbreviation_period(text: str, index: int) -> bool:
    prefix = text[max(0, index - 8):index + 1].lower()
    return any(prefix.endswith(abbreviation) for abbreviation in ("et al.", "e.g.", "i.e.", "dr.", "mr.", "ms.", "prof.", "vs."))


_FILE_SUFFIXES = frozenset({
    "bib", "csv", "docx", "go", "htm", "html", "ipynb", "jpeg", "jpg", "json",
    "md", "pdf", "png", "py", "ris", "rst", "svg", "tex", "txt", "xml", "yaml",
    "yml", "zip",
})
_DOMAIN_SUFFIXES = frozenset({
    "ai", "app", "ca", "cn", "co", "com", "de", "dev", "edu", "eu", "fr", "gov",
    "info", "io", "jp", "net", "org", "uk", "us", "xyz",
})
_TECHNICAL_TOKEN_SUFFIXES = _FILE_SUFFIXES | _DOMAIN_SUFFIXES
_INITIAL_CONTEXT_WORDS = frozenset({
    "and", "by", "from", "of", "or", "variable", "with",
})
_LABEL_CONTEXT_WORDS = frozenset({
    "appendix", "case", "equation", "figure", "item", "part", "phase", "point",
    "result", "section", "step", "table", "value", "version",
})
_MATH_VARIABLE_LETTERS = frozenset("CFKMNPQRSTXYZ")


def _period_belongs_to_token_or_initial(text: str, index: int) -> bool:
    char_before = text[index - 1] if index > 0 else ""
    char_after = text[index + 1] if index + 1 < len(text) else ""
    if char_before.isdigit() and char_after.isdigit():
        return True
    token_start = index
    while token_start > 0 and not text[token_start - 1].isspace():
        token_start -= 1
    token_end = index + 1
    while token_end < len(text) and not text[token_end].isspace():
        token_end += 1
    token = text[token_start:token_end]
    if re.fullmatch(r"(?:[A-Za-z]\.){2,}", token):
        return True
    if char_before.isalnum() and char_after.isalnum():
        token_prefix = text[token_start:index]
        if any(separator in token_prefix for separator in "/\\:@"):
            return True
        suffix_end = index + 1
        while suffix_end < len(text) and text[suffix_end].isalnum():
            suffix_end += 1
        return text[index + 1:suffix_end].lower() in _TECHNICAL_TOKEN_SUFFIXES
    letter_start = index - 1
    if char_before.isupper() and (letter_start == 0 or not text[letter_start - 1].isalnum()):
        preceding_word = re.search(r"([A-Za-z][A-Za-z'’-]*)\s+$", text[:letter_start])
        following = re.search(r"\S", text[index + 1:])
        if not following or not following.group(0).isupper():
            return False
        if letter_start == 0 or text[letter_start - 1] in "([{":
            return True
        if preceding_word:
            word = preceding_word.group(1)
            if word.lower() == "variable" and char_before in _MATH_VARIABLE_LETTERS:
                return False
            if word.lower() in _INITIAL_CONTEXT_WORDS:
                return True
            if word[0].isupper() and word.lower() not in _LABEL_CONTEXT_WORDS:
                return True
        return bool(re.search(r"(?:^|[\s([{])([A-Z])\.$", text[:letter_start].rstrip()))
    return False


def _is_claim_boundary(text: str, index: int) -> bool:
    char = text[index]
    if char in ";\n":
        return True
    if char not in ".!?":
        return False
    if char != ".":
        return True
    return not _is_abbreviation_period(text, index) and not _period_belongs_to_token_or_initial(text, index)


def _claim_bounds(text: str, start: int, end: int) -> tuple[int, int]:
    left = 0
    for index in range(start - 1, -1, -1):
        if _is_claim_boundary(text, index):
            left = index + 1
            break
    right = len(text)
    for index in range(end, len(text)):
        if _is_claim_boundary(text, index):
            right = index
            break
    return left, right


def _citation_claim_text(text: str, start: int, end: int) -> str:
    boundary_end = end
    while boundary_end > start and text[boundary_end - 1] in ".,;:)":
        boundary_end -= 1
    left_break, right_break = _claim_bounds(text, start, boundary_end)
    before = text[left_break:start]
    after = text[end:right_break] if end < right_break else ""
    sentence = CITATION_RE.sub(" ", f"{before} {after}")
    sentence = re.sub(r"[()\[\]]+", " ", sentence)
    return _normalize_claim(sentence)


def _evidence_claim_matches(entry: dict[str, Any], citation_claim: str) -> bool:
    evidence_claim = _normalize_claim(entry.get("claim"))
    return bool(evidence_claim and citation_claim and evidence_claim == citation_claim)


def _source_has_verified_evidence(
    source: dict[str, Any],
    active_sources: list[dict[str, Any]],
    registered_sources: list[dict[str, Any]],
    evidence_entries: list[dict[str, Any]],
    citation_claim: str,
) -> bool:
    identity = _source_identity(source)
    return any(
        identity in {_source_identity(match) for match in _evidence_matching_sources(entry, active_sources, registered_sources)}
        and _evidence_claim_matches(entry, citation_claim)
        for entry in evidence_entries
        if isinstance(entry, dict)
    )


def _authorized(
    reference: str,
    active_sources: list[dict[str, Any]],
    registered_sources: list[dict[str, Any]],
    evidence_entries: list[dict[str, Any]],
    citation_claim: str,
) -> bool:
    return any(
        _source_has_verified_evidence(
            source, active_sources, registered_sources, evidence_entries, citation_claim
        )
        for source in _authorized_sources(reference, active_sources, registered_sources)
    )


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def _verification_records(source: dict[str, Any]) -> list[dict[str, Any]]:
    metadata = source.get("metadata") if isinstance(source.get("metadata"), dict) else {}
    records = metadata.get("verifications")
    result = [record for record in records if isinstance(record, dict)] if isinstance(records, list) else []
    if isinstance(metadata.get("verification"), dict):
        result.append(metadata["verification"])
    return result


def _evidence_survives_source_revision(entry: dict[str, Any], source: dict[str, Any]) -> bool:
    if source.get("verificationState") == "verified":
        locator = str(entry.get("locator") or "").strip().lower()
        quote = re.sub(r"\s+", " ", str(entry.get("quote") or "")).strip()
        claim = _normalize_claim(entry.get("claim"))
        source_hash = str(entry.get("sourceContentHash") or "").strip().lower()
        current_hash = str(source.get("observedContentHash") or source.get("contentHash") or "").strip().lower()
        if not locator or not quote or not claim or not source_hash or source_hash != current_hash:
            return False
        return any(
            locator == str(record.get("locator") or "").strip().lower()
            and quote == re.sub(r"\s+", " ", str(record.get("quote") or "")).strip()
            and claim == _normalize_claim(record.get("claim"))
            and source_hash == str(record.get("contentHash") or "").strip().lower()
            for record in _verification_records(source)
        )
    metadata = source.get("metadata") if isinstance(source.get("metadata"), dict) else {}
    cutoff = _parse_timestamp(metadata.get("evidenceInvalidBefore") or source.get("evidenceInvalidBefore"))
    if cutoff is None:
        return True
    added_at = _parse_timestamp(entry.get("addedAt"))
    return added_at is not None and added_at > cutoff


def _evidence_entry_authorized(
    entry: dict[str, Any],
    active_sources: list[dict[str, Any]],
    registered_sources: list[dict[str, Any]],
) -> bool:
    reference = entry.get("source")
    if not isinstance(reference, str) or not reference.strip():
        return False
    return _matches_any_source(reference, active_sources, entry) and _matches_any_source(
        reference, registered_sources, entry
    )


def _number_set(value: str) -> set[int]:
    numbers: set[int] = set()
    for part in re.split(r"\s*,\s*", value):
        if "–" in part or "-" in part:
            start_text, end_text = re.split(r"[–-]", part, maxsplit=1)
            start, end = int(start_text), int(end_text)
            if start <= end:
                numbers.update(range(start, end + 1))
        elif part.strip():
            numbers.add(int(part))
    return numbers


def _bibliography_entries(text: str) -> dict[int, str]:
    entries = {}
    for line in text.splitlines():
        match = re.match(r"\s*\[(\d+)\]\s+(.+)", line)
        if match:
            entries[int(match.group(1))] = match.group(2).strip()
    return entries


def _source_identity(source: dict[str, Any]) -> str:
    if source.get("id"):
        return f"id:{source['id']}"
    if source.get("stableIdentifier"):
        return f"stable:{source['stableIdentifier']}"
    if source.get("doi"):
        return f"doi:{str(source['doi']).lower()}"
    if source.get("url"):
        return f"url:{_normalized_url(source['url']) or source['url']}"
    return f"locator:{str(source.get('localLocator') or '').replace(chr(92), '/').lower()}"


def _bibliography_entry_matches_source(entry: str, source: dict[str, Any]) -> bool:
    if not isinstance(source, dict) or not _source_allowed(source):
        return False
    source_doi = _doi(source.get("doi") or source.get("stableIdentifier"))
    entry_doi = _doi(entry)
    if entry_doi:
        return bool(source_doi and entry_doi == source_doi)
    source_url = _normalized_url(source.get("url"))
    if source_url:
        for url_match in re.findall(r"https?://[^\s<>`\"']+", entry, flags=re.IGNORECASE):
            if _normalized_url(url_match.rstrip(".,;)")) == source_url:
                return True
    title = _normalized_title(source.get("title"))
    if title:
        segments = [_normalized_title(segment) for segment in re.split(r"[.;]\s*", entry)]
        if title in segments:
            return True
        normalized_entry = re.sub(r"\s+(?:19|20)\d{2}[a-z]?\s*$", "", _normalized_title(entry))
        if normalized_entry == title:
            return True
    for key in ("citekey", "stableIdentifier"):
        token = str(source.get(key) or "").strip()
        if token.startswith(("http://", "https://")):
            continue
        token = token.lower()
        if token and re.search(rf"(?<![\w/]){re.escape(token)}(?![\w/])", entry.lower()):
            return True
    return False


def _evidence_matching_sources(
    entry: dict[str, Any],
    active_sources: list[dict[str, Any]],
    registered_sources: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    reference = entry.get("source")
    if not isinstance(reference, str) or not reference.strip():
        return []
    active_matches = {
        _source_identity(source): source
        for source in active_sources
        if isinstance(source, dict)
        and _reference_matches_source(reference, source)
        and _evidence_survives_source_revision(entry, source)
    }
    registered_matches = {
        _source_identity(source): source
        for source in registered_sources
        if isinstance(source, dict)
        and _reference_matches_source(reference, source)
        and _evidence_survives_source_revision(entry, source)
    }
    return [active_matches[key] for key in active_matches.keys() & registered_matches.keys()]


def _out_of_boundary_evidence(
    entries: list[dict[str, Any]],
    active_sources: list[dict[str, Any]],
    registered_sources: list[dict[str, Any]],
) -> list[str]:
    unresolved = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        source = entry.get("source")
        if isinstance(source, str) and source.strip() and not _evidence_entry_authorized(
            entry, active_sources, registered_sources
        ):
            unresolved.append(source)
    return unresolved


def audit_citations(
    *,
    text: str,
    active_sources: list[dict[str, Any]],
    registered_sources: list[dict[str, Any]],
    evidence_entries: list[dict[str, Any]],
) -> dict[str, Any]:
    payload = text or ""
    citation_text = "\n".join(
        line for line in payload.splitlines()
        if not re.match(r"\s*\[\d+\]\s+", line)
    )
    citation_matches = list(CITATION_RE.finditer(citation_text))
    citations = [match.group(0) for match in citation_matches]
    forbidden = []
    bibliography = _bibliography_entries(payload)
    number_sources: dict[int, list[dict[str, Any]]] = {}
    number_evidence: dict[int, list[dict[str, Any]]] = {}
    for entry in evidence_entries:
        if not isinstance(entry, dict) or not str(entry.get("citationNumber") or "").isdigit():
            continue
        number = int(entry["citationNumber"])
        for source in _evidence_matching_sources(entry, active_sources, registered_sources):
            sources = number_sources.setdefault(number, [])
            if _source_identity(source) not in {_source_identity(item) for item in sources}:
                sources.append(source)
            number_evidence.setdefault(number, []).append(entry)

    for citation_match in citation_matches:
        citation = citation_match.group(0)
        citation_claim = _citation_claim_text(citation_text, citation_match.start(), citation_match.end())
        cleaned = citation.rstrip(".,;")
        if re.match(r"^DOI\s+", cleaned, flags=re.IGNORECASE):
            cleaned = _doi(cleaned) or cleaned
        if cleaned.lower().startswith(("http://", "https://")):
            while cleaned.endswith(")") and cleaned.count(")") > cleaned.count("("):
                cleaned = cleaned[:-1]
        number_match = NUMBER_RE.fullmatch(cleaned)
        if number_match:
            numbers = _number_set(number_match.group(1))
            for number in numbers:
                mapped_sources = number_sources.get(number, [])
                if len({_source_identity(source) for source in mapped_sources}) > 1:
                    forbidden.append(cleaned)
                    break
                bibliography_entry = bibliography.get(number)
                if bibliography_entry:
                    if not any(
                        _bibliography_entry_matches_source(bibliography_entry, source)
                        for source in mapped_sources
                    ):
                        forbidden.append(cleaned)
                        break
                elif not mapped_sources:
                    forbidden.append(cleaned)
                    break
                if not any(_evidence_claim_matches(entry, citation_claim) for entry in number_evidence.get(number, [])):
                    forbidden.append(cleaned)
                    break
            continue
        latex = LATEX_RE.fullmatch(cleaned.strip())
        if latex:
            keys = [key.strip().lower() for key in latex.group(1).split(",") if key.strip()]
            active_by_key = {
                str(source.get("citekey") or "").lower(): source
                for source in active_sources
                if _source_allowed(source) and source.get("citekey")
            }
            registered_by_key = {
                str(source.get("citekey") or "").lower(): source
                for source in registered_sources
                if _source_allowed(source) and source.get("citekey")
            }
            if any(
                key not in active_by_key
                or key not in registered_by_key
                or _source_identity(active_by_key[key]) != _source_identity(registered_by_key[key])
                or not _source_has_verified_evidence(
                    active_by_key[key], active_sources, registered_sources, evidence_entries, citation_claim
                )
                for key in keys
            ):
                forbidden.append(cleaned)
            continue
        if not _authorized(cleaned, active_sources, registered_sources, evidence_entries, citation_claim):
            forbidden.append(cleaned)

    return {
        "citationCount": len(citations),
        "outOfBoundaryCitations": forbidden,
        "outOfBoundaryEvidenceSources": _out_of_boundary_evidence(
            evidence_entries, active_sources, registered_sources
        ),
    }
