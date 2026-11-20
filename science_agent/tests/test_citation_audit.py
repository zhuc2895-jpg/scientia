from __future__ import annotations

import unittest

from science_agent.citation_audit import audit_citations


class CitationAuditTests(unittest.TestCase):
    def test_number_ranges_expand_every_reference(self) -> None:
        source = {"localLocator": ".science/sources/paper.md", "title": "Paper"}
        result = audit_citations(
            text="Claim [1-3]. Limitation: one source.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[
                {"source": "paper.md", "citationNumber": 1},
                {"source": "paper.md", "citationNumber": 3},
            ],
        )
        self.assertEqual(result["outOfBoundaryCitations"], ["[1-3]"])

    def test_bibliography_title_requires_exact_source_identity(self) -> None:
        source = {"localLocator": ".science/sources/paper.md", "title": "Methods"}
        result = audit_citations(
            text="Claim [1]. Limitation: x.\nReferences\n[1] Unregistered Methods Paper. 2023.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[{"source": "paper.md", "citationNumber": 1}],
        )
        self.assertEqual(result["outOfBoundaryCitations"], ["[1]"])

    def test_bibliography_rejects_identity_extension(self) -> None:
        source = {"localLocator": ".science/sources/paper.md", "title": "A Reproducible Trial"}
        result = audit_citations(
            text="Claim [1]. Limitation: x.\nReferences\n[1] A Reproducible Trial Revision. 2023.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[{"source": "paper.md", "citationNumber": 1}],
        )
        self.assertEqual(result["outOfBoundaryCitations"], ["[1]"])

    def test_url_path_case_is_not_folded(self) -> None:
        source = {"url": "https://example.com/paper", "localLocator": ".science/sources/paper.html"}
        result = audit_citations(
            text="See https://example.com/Paper. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[],
        )
        self.assertEqual(result["outOfBoundaryCitations"], ["https://example.com/Paper"])

    def test_latex_cite_allows_space_before_braces(self) -> None:
        source = {"localLocator": ".science/sources/paper.md", "citekey": "smith2024"}
        result = audit_citations(
            text="See \\cite {smith2024}. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[],
        )
        self.assertEqual(result["outOfBoundaryCitations"], [])

    def test_author_year_requires_complete_author_set(self) -> None:
        source = {
            "localLocator": ".science/sources/paper.md",
            "authors": ["Jane Smith", "John Jones"],
            "year": 2023,
        }
        incomplete = audit_citations(
            text="See (Smith, 2023). Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[],
        )
        self.assertEqual(incomplete["outOfBoundaryCitations"], ["(Smith, 2023)"])
        complete = audit_citations(
            text="See (Smith and Jones, 2023). Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[],
        )
        self.assertEqual(complete["outOfBoundaryCitations"], [])

    def test_evidence_created_before_source_revision_is_invalid(self) -> None:
        source = {
            "localLocator": ".science/sources/paper.md",
            "metadata": {"evidenceInvalidBefore": "2026-11-20T10:00:00.000Z"},
        }
        old_evidence = audit_citations(
            text="Claim [1]. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[{
                "source": "paper.md",
                "citationNumber": 1,
                "addedAt": "2026-11-20T09:59:59.000Z",
            }],
        )
        self.assertEqual(old_evidence["outOfBoundaryCitations"], ["[1]"])
        self.assertEqual(old_evidence["outOfBoundaryEvidenceSources"], ["paper.md"])

        new_evidence = audit_citations(
            text="Claim [1]. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[{
                "source": "paper.md",
                "citationNumber": 1,
                "addedAt": "2026-11-20T10:00:01.000Z",
            }],
        )
        self.assertEqual(new_evidence["outOfBoundaryCitations"], [])


    def test_numeric_bibliography_must_match_the_evidence_source_mapping(self) -> None:
        first = {"id": "source-1", "localLocator": ".science/sources/first.md", "title": "First Paper"}
        second = {"id": "source-2", "localLocator": ".science/sources/second.md", "title": "Second Paper"}
        result = audit_citations(
            text="Claim [1]. Limitation: x.\nReferences\n[1] Second Paper. 2024.",
            active_sources=[first, second],
            registered_sources=[first, second],
            evidence_entries=[{"source": "first.md", "citationNumber": 1}],
        )
        self.assertEqual(result["outOfBoundaryCitations"], ["[1]"])


    def test_bibliography_url_path_case_is_not_folded(self) -> None:
        source = {
            "id": "source-1",
            "localLocator": ".science/sources/paper.html",
            "url": "https://example.com/paper",
        }
        result = audit_citations(
            text="Claim [1]. Limitation: x.\nReferences\n[1] https://example.com/Paper. 2024.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[{"source": "paper.html", "citationNumber": 1}],
        )
        self.assertEqual(result["outOfBoundaryCitations"], ["[1]"])


    def test_evidence_must_match_a_verified_locator_quote_claim_and_content_hash(self) -> None:
        source = {
            "id": "source-1",
            "localLocator": ".science/sources/paper.md",
            "contentHash": "a" * 64,
            "observedContentHash": "a" * 64,
            "verificationState": "verified",
            "metadata": {
                "verification": {
                    "locator": "line:3",
                    "quote": "The intervention reduced error.",
                    "claim": "The intervention reduced error.",
                    "contentHash": "a" * 64,
                },
            },
        }
        matching = audit_citations(
            text="Claim [1]. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[{
                "source": "paper.md",
                "citationNumber": 1,
                "locator": "line:3",
                "quote": "The intervention reduced error.",
                "claim": "The intervention reduced error.",
                "sourceContentHash": "a" * 64,
            }],
        )
        self.assertEqual(matching["outOfBoundaryCitations"], [])
        old_version = audit_citations(
            text="Claim [1]. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[{
                "source": "paper.md",
                "citationNumber": 1,
                "locator": "line:3",
                "quote": "The intervention reduced error.",
                "claim": "The intervention reduced error.",
                "sourceContentHash": "b" * 64,
                "addedAt": "2099-01-01T00:00:00Z",
            }],
        )
        self.assertEqual(old_version["outOfBoundaryCitations"], ["[1]"])
        unrelated_claim = audit_citations(
            text="Claim [1]. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[{
                "source": "paper.md",
                "citationNumber": 1,
                "locator": "line:3",
                "quote": "The intervention reduced error.",
                "claim": "An unrelated conclusion.",
                "sourceContentHash": "a" * 64,
            }],
        )
        self.assertEqual(unrelated_claim["outOfBoundaryCitations"], ["[1]"])

    def test_bibliography_doi_requires_an_exact_boundary(self) -> None:
        source = {
            "id": "source-1",
            "localLocator": ".science/sources/paper.md",
            "title": "A Reproducible Trial",
            "doi": "10.1000/abc",
            "contentHash": "a" * 64,
            "observedContentHash": "a" * 64,
            "verificationState": "verified",
            "metadata": {
                "verification": {
                    "locator": "line:3",
                    "quote": "Supported result.",
                    "claim": "The result is supported.",
                    "contentHash": "a" * 64,
                },
            },
        }
        evidence = [{
            "source": "paper.md",
            "citationNumber": 1,
            "locator": "line:3",
            "quote": "Supported result.",
            "claim": "The result is supported.",
            "sourceContentHash": "a" * 64,
        }]
        prefix = audit_citations(
            text="Claim [1]. Limitation: x.\nReferences\n[1] 10.1000/abc.1. 2024.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=evidence,
        )
        self.assertEqual(prefix["outOfBoundaryCitations"], ["[1]"])
        formatted = audit_citations(
            text="Claim [1]. Limitation: x.\nReferences\n[1] Smith, J. A Reproducible Trial. Journal of Tests. 2024.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=evidence,
        )
        self.assertEqual(formatted["outOfBoundaryCitations"], [])


if __name__ == "__main__":
    unittest.main()
