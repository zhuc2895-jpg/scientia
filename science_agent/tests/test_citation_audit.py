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


def verified_pair(claim: str, locator: str = ".science/sources/paper.md", *, source_id=None, citation_number=None):
    source = verified_source(
        locator,
        **({"id": source_id} if source_id is not None else {}),
        metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": claim, "contentHash": "a" * 64}},
    )
    evidence = verified_evidence(
        locator,
        **({"citationNumber": citation_number} if citation_number is not None else {}),
        claim=claim,
    )
    return source, evidence


class CitationAuditTests(unittest.TestCase):
    def assert_single_claim_contract(self, text: str, full_claim: str, narrow_claim: str) -> None:
        narrow_source, narrow_evidence = verified_pair(narrow_claim, citation_number=1)
        narrow_result = audit_citations(
            text=text,
            active_sources=[narrow_source],
            registered_sources=[narrow_source],
            evidence_entries=[narrow_evidence],
        )
        self.assertEqual(narrow_result["outOfBoundaryCitations"], ["[1]"])

        full_source, full_evidence = verified_pair(full_claim, citation_number=1)
        full_result = audit_citations(
            text=text,
            active_sources=[full_source],
            registered_sources=[full_source],
            evidence_entries=[full_evidence],
        )
        self.assertEqual(full_result["outOfBoundaryCitations"], [])

    def assert_claim_authorized(self, text: str, claim: str) -> None:
        source, evidence = verified_pair(claim, citation_number=1)
        result = audit_citations(
            text=text,
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[evidence],
        )
        self.assertEqual(result["outOfBoundaryCitations"], [])

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
        first_evidence = verified_evidence(
            ".science/sources/first.md",
            citationNumber=1,
            claim="First result is supported",
        )
        second = verified_source(
            ".science/sources/second.md",
            id="second",
            metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": "Second result is rejected", "contentHash": "a" * 64}},
        )
        evidence = [
            first_evidence,
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


    def test_ambiguous_multi_citation_coordination_uses_the_whole_sentence(self) -> None:
        cases = (
            ("First result is supported [1] and second result is rejected [2].", "First result is supported and second result is rejected"),
            ("First result is supported [1] but second result is rejected [2].", "First result is supported but second result is rejected"),
            ("First result is supported [1] while second result is rejected [2].", "First result is supported while second result is rejected"),
        )
        for text, claim in cases:
            with self.subTest(text=text):
                first, first_evidence = verified_pair(
                    claim, ".science/sources/first.md", source_id="first", citation_number=1
                )
                second, second_evidence = verified_pair(
                    claim, ".science/sources/second.md", source_id="second", citation_number=2
                )
                result = audit_citations(
                    text=text,
                    active_sources=[first, second],
                    registered_sources=[first, second],
                    evidence_entries=[first_evidence, second_evidence],
                )
                self.assertEqual(result["outOfBoundaryCitations"], [])

                narrow_first, narrow_first_evidence = verified_pair(
                    "First result is supported",
                    ".science/sources/first.md",
                    source_id="first",
                    citation_number=1,
                )
                narrow_second, narrow_second_evidence = verified_pair(
                    "Second result is rejected",
                    ".science/sources/second.md",
                    source_id="second",
                    citation_number=2,
                )
                narrow_result = audit_citations(
                    text=text,
                    active_sources=[narrow_first, narrow_second],
                    registered_sources=[narrow_first, narrow_second],
                    evidence_entries=[narrow_first_evidence, narrow_second_evidence],
                )
                self.assertEqual(narrow_result["outOfBoundaryCitations"], ["[1]", "[2]"])


    def test_claim_normalization_preserves_meaning_changing_punctuation(self) -> None:
        source = verified_source(
            ".science/sources/paper.md",
            metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": "No evidence supports this", "contentHash": "a" * 64}},
        )
        evidence = verified_evidence(
            ".science/sources/paper.md",
            citationNumber=1,
            claim="No evidence supports this",
        )
        result = audit_citations(
            text="No, evidence supports this [1]. Limitation: x.",
            active_sources=[source],
            registered_sources=[source],
            evidence_entries=[evidence],
        )
        self.assertEqual(result["outOfBoundaryCitations"], ["[1]"])

    def test_ambiguous_coordination_requires_the_whole_sentence_claim(self) -> None:
        cases = (
            (
                "Alpha was observed and beta was confirmed [1].",
                "Alpha was observed and beta was confirmed",
                "Beta was confirmed",
            ),
            (
                "Alpha reported and beta was confirmed [1].",
                "Alpha reported and beta was confirmed",
                "Beta was confirmed",
            ),
            (
                "Alpha reports and beta was confirmed [1].",
                "Alpha reports and beta was confirmed",
                "Beta was confirmed",
            ),
            (
                "The report, and appendix support the result [1].",
                "The report, and appendix support the result",
                "appendix support the result",
            ),
            (
                "Alpha was observed, and the report, and appendix support the result [1].",
                "Alpha was observed, and the report, and appendix support the result",
                "The report, and appendix support the result",
            ),
            (
                "The red reports and appendix support the result [1].",
                "The red reports and appendix support the result",
                "appendix support the result",
            ),
        )
        for text, full_claim, narrow_claim in cases:
            with self.subTest(text=text):
                self.assert_single_claim_contract(text, full_claim, narrow_claim)

    def test_internal_periods_do_not_narrow_a_sentence_claim(self) -> None:
        cases = (
            (
                "The rate increased by 0.5 [1].",
                "The rate increased by 0.5",
                "5",
            ),
            (
                "J. Smith reported the result [1].",
                "J. Smith reported the result",
                "Smith reported the result",
            ),
            (
                "The model by J. Smith was rejected [1].",
                "The model by J. Smith was rejected",
                "Smith was rejected",
            ),
            (
                "The U.S. report is supported [1].",
                "The U.S. report is supported",
                "report is supported",
            ),
        )
        for text, full_claim, narrow_claim in cases:
            with self.subTest(text=text):
                self.assert_single_claim_contract(text, full_claim, narrow_claim)

    def test_non_initial_periods_keep_the_following_claim_independent(self) -> None:
        cases = (
            ("Result X. Beta was rejected [1].", "Beta was rejected"),
            ("The result was supported.Next result was rejected [1].", "Next result was rejected"),
            ("The result was supported.next result was rejected [1].", "next result was rejected"),
        )
        for text, claim in cases:
            with self.subTest(text=text):
                self.assert_claim_authorized(text, claim)

    def test_technical_token_periods_do_not_narrow_the_claim(self) -> None:
        cases = (
            (
                "The result in manuscript.md is supported [1].",
                "The result in manuscript.md is supported",
                "md is supported",
            ),
            (
                "See example.com for details [1].",
                "See example.com for details",
                "com for details",
            ),
            (
                "The result in manuscript.MD is supported [1].",
                "The result in manuscript.MD is supported",
                "MD is supported",
            ),
            (
                "See Example.COM for details [1].",
                "See Example.COM for details",
                "COM for details",
            ),
            (
                r"See data\\report.md for details [1].",
                r"See data\\report.md for details",
                r"report.md for details",
            ),
        )
        for text, full_claim, narrow_claim in cases:
            with self.subTest(text=text):
                self.assert_single_claim_contract(text, full_claim, narrow_claim)

    def test_separator_after_no_space_period_does_not_merge_claims(self) -> None:
        self.assert_claim_authorized(
            "The result was supported.Next: result was rejected [1].",
            "next: result was rejected",
        )

    def test_sentence_initial_coordination_is_part_of_the_claim(self) -> None:
        self.assert_single_claim_contract(
            "But beta was rejected [1].",
            "But beta was rejected",
            "beta was rejected",
        )

    def test_hard_sentence_boundaries_keep_citation_claims_independent(self) -> None:
        first = verified_source(
            ".science/sources/first.md",
            id="first",
            metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": "Alpha was supported", "contentHash": "a" * 64}},
        )
        second = verified_source(
            ".science/sources/second.md",
            id="second",
            metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": "Beta, according to Smith, and Jones, was confirmed", "contentHash": "a" * 64}},
        )
        evidence = [
            verified_evidence(".science/sources/first.md", citationNumber=1, claim="Alpha was supported"),
            verified_evidence(".science/sources/second.md", citationNumber=2, claim="Beta, according to Smith, and Jones, was confirmed"),
        ]
        result = audit_citations(
            text="Alpha was supported [1]. Beta, according to Smith, and Jones, was confirmed [2]. Limitation: x.",
            active_sources=[first, second],
            registered_sources=[first, second],
            evidence_entries=evidence,
        )
        self.assertEqual(result["outOfBoundaryCitations"], [])

    def test_period_semicolon_and_newline_boundaries_keep_claims_independent(self) -> None:
        first = verified_source(
            ".science/sources/first.md",
            id="first",
            metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": "Alpha was supported", "contentHash": "a" * 64}},
        )
        second = verified_source(
            ".science/sources/second.md",
            id="second",
            metadata={"verification": {"locator": "line:3", "quote": "Supported result.", "claim": "Beta was confirmed", "contentHash": "a" * 64}},
        )
        evidence = [
            verified_evidence(".science/sources/first.md", citationNumber=1, claim="Alpha was supported"),
            verified_evidence(".science/sources/second.md", citationNumber=2, claim="Beta was confirmed"),
        ]
        for boundary in (". ", "; ", "\n"):
            with self.subTest(boundary=repr(boundary)):
                result = audit_citations(
                    text=f"Alpha was supported [1]{boundary}Beta was confirmed [2]. Limitation: x.",
                    active_sources=[first, second],
                    registered_sources=[first, second],
                    evidence_entries=evidence,
                )
                self.assertEqual(result["outOfBoundaryCitations"], [])


if __name__ == "__main__":
    unittest.main()
