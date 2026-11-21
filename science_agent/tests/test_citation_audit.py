from __future__ import annotations

import unittest

from science_agent.citation_audit import audit_citations


def verified_source(locator: str, **overrides):
    source = {
        "id": "source-1",
        "localLocator": locator,
        "title": "Paper",
        "verificationState": "verified",
        "freshnessState": "current",
        "contentHash": "a" * 64,
        "observedContentHash": "a" * 64,
        "metadata": {
            "verification": {
                "locator": "line:3",
                "quote": "Supported result.",
                "claim": "The result is supported.",
                "contentHash": "a" * 64,
            },
        },
    }
    source.update(overrides)
    return source


def verified_evidence(locator: str, **overrides):
    entry = {
        "source": locator.rsplit("/", 1)[-1],
        "locator": "line:3",
        "quote": "Supported result.",
        "claim": "The result is supported.",
        "sourceContentHash": "a" * 64,
    }
    entry.update(overrides)
    return entry


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
        source = verified_source(".science/sources/paper.md", citekey="smith2024")
        result = audit_citations(
            text="The result is supported \\cite {smith2024}. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[verified_evidence(".science/sources/paper.md")],
        )
        self.assertEqual(result["outOfBoundaryCitations"], [])

    def test_author_year_requires_complete_author_set(self) -> None:
        source = verified_source(
            ".science/sources/paper.md",
            authors=["Jane Smith", "John Jones"],
            year=2023,
        )
        incomplete = audit_citations(
            text="The result is supported (Smith, 2023). Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[],
        )
        self.assertEqual(incomplete["outOfBoundaryCitations"], ["(Smith, 2023)"])
        complete = audit_citations(
            text="The result is supported (Smith and Jones, 2023). Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[verified_evidence(".science/sources/paper.md")],
        )
        self.assertEqual(complete["outOfBoundaryCitations"], [])

    def test_evidence_created_before_source_revision_is_invalid(self) -> None:
        source = verified_source('.science/sources/paper.md')
        old_evidence = audit_citations(
            text="The result is supported [1]. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[verified_evidence(".science/sources/paper.md", citationNumber=1, sourceContentHash="b" * 64)],
        )
        self.assertEqual(old_evidence["outOfBoundaryCitations"], ["[1]"])
        self.assertEqual(old_evidence["outOfBoundaryEvidenceSources"], ["paper.md"])

        new_evidence = audit_citations(
            text="The result is supported [1]. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[verified_evidence(".science/sources/paper.md", citationNumber=1)],
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
            "freshnessState": "current",
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
            text="The intervention reduced error [1]. Limitation: x.",
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
            text="The intervention reduced error [1]. Limitation: x.",
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
            text="The intervention reduced error [1]. Limitation: x.",
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
            "freshnessState": "current",
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
            text="The result is supported [1]. Limitation: x.\nReferences\n[1] 10.1000/abc.1. 2024.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=evidence,
        )
        self.assertEqual(prefix["outOfBoundaryCitations"], ["[1]"])
        formatted = audit_citations(
            text="The result is supported [1]. Limitation: x.\nReferences\n[1] Smith, J. A Reproducible Trial. Journal of Tests. 2024.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=evidence,
        )
        self.assertEqual(formatted["outOfBoundaryCitations"], [])


    def test_latex_citation_requires_the_active_source_set(self) -> None:
        source = {
            "id": "source-1",
            "localLocator": ".science/sources/paper.md",
            "citekey": "smith2024",
            "verificationState": "verified",
            "freshnessState": "current",
            "contentHash": "a" * 64,
            "observedContentHash": "a" * 64,
        }
        result = audit_citations(
            text="See \\cite{smith2024}. Limitation: x.",
            active_sources=[],
            registered_sources=[source],
            evidence_entries=[],
        )
        self.assertEqual(result["outOfBoundaryCitations"], ["\\cite{smith2024}"])

    def test_non_numeric_citation_requires_matching_verified_evidence(self) -> None:
        source = {
            "id": "source-1",
            "localLocator": ".science/sources/paper.md",
            "doi": "10.1000/abc",
            "verificationState": "verified",
            "freshnessState": "current",
            "contentHash": "a" * 64,
            "observedContentHash": "a" * 64,
            "metadata": {
                "verification": {
                    "locator": "line:3",
                    "quote": "Supported result.",
                    "claim": "The result is supported.",
                    "contentHash": "a" * 64,
                },
            },
        }
        without_evidence = audit_citations(
            text="The result is supported 10.1000/abc. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[],
        )
        self.assertEqual(without_evidence["outOfBoundaryCitations"], ["10.1000/abc"])
        with_evidence = audit_citations(
            text="The result is supported 10.1000/abc. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[{
                "source": "paper.md",
                "locator": "line:3",
                "quote": "Supported result.",
                "claim": "The result is supported.",
                "sourceContentHash": "a" * 64,
            }],
        )
        self.assertEqual(with_evidence["outOfBoundaryCitations"], [])

    def test_source_without_verification_state_cannot_authorize_a_citation(self) -> None:
        source = {
            "id": "source-1",
            "localLocator": ".science/sources/paper.md",
            "doi": "10.1000/abc",
            "freshnessState": "current",
            "contentHash": "a" * 64,
            "observedContentHash": "a" * 64,
        }
        result = audit_citations(
            text="The result is supported 10.1000/abc. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[],
        )
        self.assertEqual(result["outOfBoundaryCitations"], ["10.1000/abc"])


    def test_numeric_citation_must_match_the_cited_evidence_claim(self) -> None:
        source = verified_source(".science/sources/paper.md")
        evidence = verified_evidence(".science/sources/paper.md", citationNumber=1)
        unrelated = audit_citations(
            text="The moon is made of cheese [1]. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[evidence],
        )
        self.assertEqual(unrelated["outOfBoundaryCitations"], ["[1]"])
        matching = audit_citations(
            text="The result is supported [1]. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[evidence],
        )
        self.assertEqual(matching["outOfBoundaryCitations"], [])

    def test_non_numeric_citation_must_match_the_cited_evidence_claim(self) -> None:
        source = verified_source(".science/sources/paper.md", doi="10.1000/abc")
        evidence = verified_evidence(".science/sources/paper.md")
        unrelated = audit_citations(
            text="The moon is made of cheese (DOI 10.1000/abc). Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[evidence],
        )
        self.assertEqual(unrelated["outOfBoundaryCitations"], ["10.1000/abc"])
        matching = audit_citations(
            text="The result is supported 10.1000/abc. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[evidence],
        )
        self.assertEqual(matching["outOfBoundaryCitations"], [])


    def test_numeric_citation_requires_one_shared_active_registered_source_identity(self) -> None:
        active = verified_source(".science/sources/paper.md", id="active-source")
        registered = verified_source(".science/sources/paper.md", id="registered-source")
        evidence = verified_evidence(".science/sources/paper.md", citationNumber=1, claim="The result is supported")
        result = audit_citations(
            text="The result is supported [1]. Limitation: x.",
            active_sources=[active],
            registered_sources=[registered],
            evidence_entries=[evidence],
        )
        self.assertEqual(result["outOfBoundaryCitations"], ["[1]"])


    def test_multiple_citations_in_one_sentence_bind_to_their_local_claims(self) -> None:
        first = verified_source(
            ".science/sources/first.md",
            id="first",
            metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": "First result is supported", "contentHash": "a" * 64}},
        )
        second = verified_source(
            ".science/sources/second.md",
            id="second",
            metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": "Second result is rejected", "contentHash": "a" * 64}},
        )
        evidence = [
            verified_evidence(".science/sources/first.md", citationNumber=1, claim="First result is supported"),
            verified_evidence(".science/sources/second.md", citationNumber=2, claim="Second result is rejected"),
        ]
        result = audit_citations(
            text="First result is supported [1]; second result is rejected [2]. Limitation: x.",
            active_sources=[first, second],
            registered_sources=[first, second],
            evidence_entries=evidence,
        )
        self.assertEqual(result["outOfBoundaryCitations"], [])

    def test_et_al_abbreviation_does_not_end_the_claim_sentence(self) -> None:
        source = verified_source(
            ".science/sources/paper.md",
            authors=["Jane Smith"],
            year=2023,
            metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": "Smith et al. report the result is supported", "contentHash": "a" * 64}},
        )
        evidence = verified_evidence(
            ".science/sources/paper.md",
            citationNumber=1,
            claim="Smith et al. report the result is supported",
        )
        result = audit_citations(
            text="Smith et al. report the result is supported [1]. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[evidence],
        )
        self.assertEqual(result["outOfBoundaryCitations"], [])

    def test_doi_label_is_removed_with_the_citation_token(self) -> None:
        source = verified_source(".science/sources/paper.md", doi="10.1000/abc")
        evidence = verified_evidence(".science/sources/paper.md", claim="The result is supported")
        result = audit_citations(
            text="The result is supported (DOI 10.1000/abc). Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[evidence],
        )
        self.assertEqual(result["outOfBoundaryCitations"], [])


    def test_comma_and_while_coordination_binds_each_citation_clause(self) -> None:
        first = verified_source(
            ".science/sources/first.md",
            id="first",
            metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": "First result is supported", "contentHash": "a" * 64}},
        )
        second = verified_source(
            ".science/sources/second.md",
            id="second",
            metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": "Second result is rejected", "contentHash": "a" * 64}},
        )
        evidence = [
            verified_evidence(".science/sources/first.md", citationNumber=1, claim="First result is supported"),
            verified_evidence(".science/sources/second.md", citationNumber=2, claim="Second result is rejected"),
        ]
        for text in (
            "First result is supported [1], and second result is rejected [2].",
            "First result is supported [1], second result is rejected [2].",
            "First result is supported [1] while second result is rejected [2].",
        ):
            with self.subTest(text=text):
                result = audit_citations(
                    text=f"{text} Limitation: x.",
                    active_sources=[first, second],
                    registered_sources=[first, second],
                    evidence_entries=evidence,
                )
                self.assertEqual(result["outOfBoundaryCitations"], [])


if __name__ == "__main__":
    unittest.main()
