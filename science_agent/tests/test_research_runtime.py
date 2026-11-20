from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path

from science_agent.research_runtime import (
    assess_result,
    extract_research_charter,
    finalize_research_run,
    prepare_research_run,
)


def verified_source(locator: str, verification_claim: str = "The result is supported.", **overrides):
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
                "claim": verification_claim,
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


class ResearchRuntimeTests(unittest.TestCase):
    def test_prepare_and_finalize_records_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            (workspace / "paper.md").write_text("# Source\nA measured result.", encoding="utf-8")

            context = prepare_research_run(
                workspace,
                conversation_id="conversation-1",
                run_id="run-1",
                prompt="生成一份带引用的研究简报。",
                model="deepseek-v4-flash",
                mode="literature",
            )

            self.assertTrue((workspace / context["briefPath"]).is_file())
            self.assertTrue((workspace / context["outputDir"]).is_dir())
            brief = (workspace / context["briefPath"]).read_text(encoding="utf-8")
            self.assertIn("paper.md", brief)
            self.assertIn("文献研究", brief)

            ledger = workspace / context["evidencePath"]
            ledger.write_text(
                json.dumps({
                    "claim": "A measured result.",
                    "source": "paper.md",
                    "locator": "line 2",
                    "quote": "A measured result.",
                    "confidence": "high",
                    "addedAt": "2026-11-16T00:00:00+00:00",
                }, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            report = workspace / context["outputDir"] / "brief.md"
            report.write_text("# Brief\nSee [1]. Unknowns: none confirmed.\n", encoding="utf-8")

            result = finalize_research_run(
                workspace,
                run_context=context,
                result_text="Observed in [1]. Limitation: one source only.",
                prompt="生成一份带引用的研究简报。",
                session_id="conversation-1",
                finish_reason="completed",
            )

            self.assertEqual(result["quality"]["warnings"], 0)
            self.assertEqual(result["quality"]["evidenceAdded"], 1)
            self.assertEqual(result["quality"]["artifactCount"], 1)
            self.assertEqual(result["artifacts"][0]["name"], "brief.md")
            self.assertEqual(len(result["artifacts"][0]["sha256"]), 64)
            manifest = workspace / ".science" / "runs" / context["sessionKey"] / context["runKey"] / "manifest.json"
            self.assertTrue(manifest.is_file())
            saved = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(saved["status"], "completed")
            self.assertEqual(saved["evidenceAdded"], 1)

    def test_assess_result_flags_missing_delivery_evidence(self) -> None:
        quality = assess_result(
            "A confident answer without provenance.",
            "导出论文图表并生成报告。",
            [],
            0,
        )
        self.assertGreaterEqual(quality["warnings"], 3)
        artifact_check = next(check for check in quality["checks"] if check["id"] == "artifacts")
        self.assertEqual(artifact_check["status"], "warn")
    def test_prepare_and_finalize_reference_approved_research_charter(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            charter = {
                "version": 3,
                "status": "approved",
                "question": "Which intervention improves the outcome?",
                "contribution": "Resolve conflicting evidence.",
                "scope": "Adults in randomized trials.",
                "methodConstraints": "Prefer primary studies.",
                "successCriteria": "Traceable synthesis.",
                "paperType": "Review",
                "citationStyle": "Vancouver",
                "dataPolicy": "sensitive",
                "approvedAt": "2026-11-19T00:00:00+00:00",
            }
            context = prepare_research_run(
                workspace,
                conversation_id="conversation-charter",
                run_id="run-charter",
                prompt="Continue the evidence review.",
                model="deepseek-v4-flash",
                research_charter=charter,
                stage_key="evidence",
                project_id="project-1",
            )

            brief = (workspace / context["briefPath"]).read_text(encoding="utf-8")
            self.assertIn("Approved Research Charter v3", brief)
            self.assertIn("Data Processing Policy: `sensitive`", brief)
            self.assertIn("Research stage: `evidence`", brief)

            result = finalize_research_run(
                workspace,
                run_context=context,
                result_text="Observed a limitation.",
                prompt="Continue the evidence review.",
                status="completed",
            )
            manifest_path = workspace / ".science" / "runs" / context["sessionKey"] / context["runKey"] / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["researchCharter"]["version"], 3)
            self.assertEqual(manifest["stageKey"], "evidence")
            self.assertEqual(manifest["projectId"], "project-1")
            self.assertEqual(result["run"]["projectId"], "project-1")
            self.assertEqual(result["run"]["researchCharterVersion"], 3)

    def test_charter_draft_mode_requires_a_structured_charter_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            context = prepare_research_run(
                workspace,
                conversation_id="conversation-scoping",
                run_id="run-scoping",
                prompt="Study intermittent fasting.",
                model="deepseek-v4-flash",
                stage_key="scoping",
                charter_draft_mode=True,
            )

            self.assertIn("research-charter.json", context["promptSuffix"])
            output_dir = workspace / context["outputDir"]
            charter = {
                "question": "How does intermittent fasting affect metabolic health?",
                "contribution": "Reconcile randomized trial evidence.",
                "scope": "Adults without diagnosed metabolic disease.",
                "methodConstraints": "Prefer randomized trials.",
                "successCriteria": "A traceable evidence map.",
                "paperType": "Review",
                "citationStyle": "Vancouver",
                "dataPolicy": "standard",
            }
            (output_dir / "research-charter.json").write_text(json.dumps(charter), encoding="utf-8")

            extracted = extract_research_charter(workspace, output_dir, "Drafted the charter.")
            self.assertEqual(extracted["question"], charter["question"])
            self.assertEqual(extracted["dataPolicy"], "standard")


    def test_charter_extraction_falls_back_to_fenced_json_in_the_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            output_dir = workspace / "outputs"
            output_dir.mkdir()
            text = """The draft is ready.

```json
{"question":"Q","contribution":"C","scope":"S","methodConstraints":"M","successCriteria":"K","paperType":"Review","citationStyle":"APA 7","dataPolicy":"standard"}
```
"""
            extracted = extract_research_charter(workspace, output_dir, text)
            self.assertEqual(extracted["question"], "Q")
            self.assertEqual(extracted["citationStyle"], "APA 7")

    def test_assess_result_enforces_the_active_source_citation_boundary(self) -> None:
        active = [verified_source(".science/sources/paper.md", verification_claim="Observed in")]
        registered = [*active, {"localLocator": ".science/sources/inactive.md"}]
        active_quality = assess_result(
            "Observed in [1]. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[verified_evidence(".science/sources/paper.md", citationNumber=1, claim="Observed in")],
            registered_sources=registered,
            active_sources=active,
        )
        source_check = next(check for check in active_quality["checks"] if check["id"] == "source-boundary")
        self.assertEqual(source_check["status"], "pass")
        self.assertFalse(active_quality["blocking"])

        inactive_quality = assess_result(
            "Observed in [1]. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "inactive.md"}],
            registered_sources=registered,
            active_sources=active,
        )
        source_check = next(check for check in inactive_quality["checks"] if check["id"] == "source-boundary")
        self.assertEqual(source_check["status"], "fail")
        self.assertTrue(inactive_quality["blocking"])
        self.assertEqual(inactive_quality["outOfBoundaryEvidenceSources"], ["inactive.md"])

        citation_quality = assess_result(
            "See https://unregistered.example/paper. Limitation: one source.",
            "Summarize the evidence.",
            [],
            0,
            registered_sources=registered,
            active_sources=active,
        )
        self.assertTrue(citation_quality["blocking"])
        self.assertEqual(
            citation_quality["outOfBoundaryCitations"],
            ["https://unregistered.example/paper"],
        )

        basename_collision = assess_result(
            "See https://untrusted.example/paper.pdf. Limitation: one source.",
            "Summarize the evidence.",
            [],
            0,
            registered_sources=[{"localLocator": ".science/sources/paper.pdf"}],
            active_sources=[{"localLocator": ".science/sources/paper.pdf"}],
        )
        self.assertTrue(basename_collision["blocking"])
        self.assertEqual(
            basename_collision["outOfBoundaryCitations"],
            ["https://untrusted.example/paper.pdf"],
        )

        numbered_citation = assess_result(
            "Prior work [42] supports this. Limitation: one source.",
            "Summarize the evidence.",
            [],
            0,
            registered_sources=[],
            active_sources=[],
        )
        self.assertTrue(numbered_citation["blocking"])
        self.assertEqual(numbered_citation["outOfBoundaryCitations"], ["[42]"])

        author_year_source = [verified_source(
            ".science/sources/paper.md",
            verification_claim="Prior work supports this",
            authors=["Jane Smith"],
            year=2023,
        )]
        author_year_pass = assess_result(
            "Prior work (Smith, 2023) supports this. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[verified_evidence(".science/sources/paper.md", claim="Prior work supports this")],
            registered_sources=author_year_source,
            active_sources=author_year_source,
        )
        self.assertFalse(author_year_pass["blocking"])
        author_year_fail = assess_result(
            "Prior work (Jones, 2023) supports this. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md"}],
            registered_sources=author_year_source,
            active_sources=author_year_source,
        )
        self.assertTrue(author_year_fail["blocking"])
        self.assertEqual(author_year_fail["outOfBoundaryCitations"], ["(Jones, 2023)"])

        author_year_too_permissive = assess_result(
            "Prior work (Smith and Jones, 2023) supports this. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md"}],
            registered_sources=author_year_source,
            active_sources=author_year_source,
        )
        self.assertTrue(author_year_too_permissive["blocking"])

        bare_doi = assess_result(
            "Prior work 10.1000/unregistered supports this. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md"}],
            registered_sources=author_year_source,
            active_sources=author_year_source,
        )
        self.assertTrue(bare_doi["blocking"])
        self.assertEqual(bare_doi["outOfBoundaryCitations"], ["10.1000/unregistered"])

        numbered_bypass = assess_result(
            "Prior work [42] supports this. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md"}],
            registered_sources=author_year_source,
            active_sources=author_year_source,
        )
        self.assertTrue(numbered_bypass["blocking"])
        self.assertEqual(numbered_bypass["outOfBoundaryCitations"], ["[42]"])

        duplicate_evidence_number = assess_result(
            "Prior work [2] supports this. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md", "citationNumber": 1}],
            registered_sources=[
                {"localLocator": ".science/sources/paper.md"},
                {"localLocator": ".science/sources/second.md"},
            ],
            active_sources=[
                {"localLocator": ".science/sources/paper.md"},
                {"localLocator": ".science/sources/second.md"},
            ],
        )
        self.assertTrue(duplicate_evidence_number["blocking"])

        bibliography_source = [verified_source(
            ".science/sources/paper.md",
            title="A Reproducible Trial",
            metadata={
                "verification": {
                    "locator": "line:3",
                    "quote": "Solved result.",
                    "claim": "Claim",
                    "contentHash": "a" * 64,
                },
            },
        )]
        bibliography_evidence = [verified_evidence(
            ".science/sources/paper.md",
            citationNumber=1,
            quote="Solved result.",
            claim="Claim",
        )]
        bibliography_fail = assess_result(
            "Claim [1]. Limitation: x.\nReferences\n[1] Unregistered Paper. 2025.",
            "Cite.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md", "citationNumber": 1}],
            registered_sources=bibliography_source,
            active_sources=bibliography_source,
        )
        self.assertTrue(bibliography_fail["blocking"])
        bibliography_pass = assess_result(
            "Claim [1]. Limitation: x.\nReferences\n[1] A Reproducible Trial. 2023.",
            "Cite.",
            [],
            1,
            new_evidence_entries=bibliography_evidence,
            registered_sources=bibliography_source,
            active_sources=bibliography_source,
        )
        self.assertFalse(bibliography_pass["blocking"])
        compact_numbers = assess_result(
            "Claim [1, 2]. Limitation: x.",
            "Cite.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md", "citationNumber": 1}],
            registered_sources=bibliography_source,
            active_sources=bibliography_source,
        )
        self.assertTrue(compact_numbers["blocking"])
        self.assertEqual(compact_numbers["outOfBoundaryCitations"], ["[1, 2]"])

        range_numbers = assess_result(
            "Claim [1-3]. Limitation: x.",
            "Cite.",
            [],
            1,
            new_evidence_entries=[
                {"source": "paper.md", "citationNumber": 1},
                {"source": "paper.md", "citationNumber": 3},
            ],
            registered_sources=bibliography_source,
            active_sources=bibliography_source,
        )
        self.assertTrue(range_numbers["blocking"])
        self.assertEqual(range_numbers["outOfBoundaryCitations"], ["[1-3]"])

        latex_source = [verified_source(".science/sources/paper.md", verification_claim="Prior work", citekey="smith2024")]
        latex_pass = assess_result(
            "Prior work \\cite{smith2024}. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[verified_evidence(".science/sources/paper.md", claim="Prior work")],
            registered_sources=latex_source,
            active_sources=latex_source,
        )
        self.assertFalse(latex_pass["blocking"])
        latex_fail = assess_result(
            "Prior work \\cite{unregistered}. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md"}],
            registered_sources=latex_source,
            active_sources=latex_source,
        )
        self.assertTrue(latex_fail["blocking"])
        self.assertEqual(latex_fail["outOfBoundaryCitations"], ["\\cite{unregistered}"])
        latex_spaced_fail = assess_result(
            "Prior work \\cite {unregistered}. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md"}],
            registered_sources=latex_source,
            active_sources=latex_source,
        )
        self.assertTrue(latex_spaced_fail["blocking"])

        url_source = [verified_source(".science/sources/paper.md", verification_claim="See", url="https://example.com/paper")]
        url_fragment = assess_result(
            "See https://example.com/paper#results. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[verified_evidence(".science/sources/paper.md", claim="See")],
            registered_sources=url_source,
            active_sources=url_source,
        )
        self.assertFalse(url_fragment["blocking"])
        url_parenthesized = assess_result(
            "See (https://example.com/paper). Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[verified_evidence(".science/sources/paper.md", claim="See")],
            registered_sources=url_source,
            active_sources=url_source,
        )
        self.assertFalse(url_parenthesized["blocking"])

        path_collision = assess_result(
            "Observed in [1]. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "other/paper.pdf"}],
            registered_sources=[{"localLocator": ".science/sources/paper.pdf"}],
            active_sources=[{"localLocator": ".science/sources/paper.pdf"}],
        )
        self.assertTrue(path_collision["blocking"])
        self.assertEqual(path_collision["outOfBoundaryEvidenceSources"], ["other/paper.pdf"])

        stale_source = assess_result(
            "Observed in [1]. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md"}],
            registered_sources=[{"localLocator": ".science/sources/paper.md", "freshnessState": "stale"}],
            active_sources=[{"localLocator": ".science/sources/paper.md", "freshnessState": "stale"}],
        )
        self.assertTrue(stale_source["blocking"])
        self.assertEqual(stale_source["outOfBoundaryEvidenceSources"], ["paper.md"])

        unverified_source = assess_result(
            "Observed in [1]. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md", "citationNumber": 1}],
            registered_sources=[{"localLocator": ".science/sources/paper.md", "verificationState": "unverified"}],
            active_sources=[{"localLocator": ".science/sources/paper.md", "verificationState": "unverified"}],
        )
        self.assertTrue(unverified_source["blocking"])
        self.assertEqual(unverified_source["outOfBoundaryEvidenceSources"], ["paper.md"])

    def test_prepare_and_terminal_manifests_record_source_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            registered = [{"id": "source-1", "title": "Paper", "localLocator": ".science/sources/paper.md", "contentHash": "a" * 64}]
            active = [registered[0]]
            context = prepare_research_run(
                workspace,
                conversation_id="conversation-source-scope",
                run_id="run-source-scope",
                prompt="Continue the review.",
                model="deepseek-v4-flash",
                registered_sources=registered,
                active_sources=active,
            )
            manifest_path = workspace / ".science" / "runs" / context["sessionKey"] / context["runKey"] / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["sourceScope"]["registered"][0]["id"], "source-1")
            self.assertEqual(manifest["sourceScope"]["active"][0]["id"], "source-1")

            finalize_research_run(
                workspace,
                run_context=context,
                result_text="",
                prompt="Continue the review.",
                status="cancelled",
                error="cancelled by user",
                registered_sources=registered,
                active_sources=active,
            )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "cancelled")
            self.assertEqual(manifest["sourceScope"]["registered"][0]["id"], "source-1")

    def test_finalize_audits_generated_artifact_citations_against_active_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            context = prepare_research_run(
                workspace,
                conversation_id="conversation-artifact-gate",
                run_id="run-artifact-gate",
                prompt="Write a sourced report.",
                model="deepseek-v4-flash",
            )
            report = workspace / context["outputDir"] / "report.md"
            report.write_text("See https://unregistered.example/paper.\n", encoding="utf-8")

            result = finalize_research_run(
                workspace,
                run_context=context,
                result_text="Report written. Limitation: one source.",
                prompt="Write a sourced report.",
                status="completed",
                registered_sources=[{"localLocator": ".science/sources/paper.md"}],
                active_sources=[{"localLocator": ".science/sources/paper.md"}],
            )
            self.assertTrue(result["quality"]["blocking"])
            self.assertEqual(
                result["quality"]["outOfBoundaryCitations"],
                ["https://unregistered.example/paper"],
            )

    def test_finalize_records_registered_and_active_source_scope_in_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            context = prepare_research_run(
                workspace,
                conversation_id="conversation-source-audit",
                run_id="run-source-audit",
                prompt="Audit source scope.",
                model="deepseek-v4-flash",
            )
            registered = [{
                "id": "source-1",
                "title": "Registered paper",
                "localLocator": ".science/sources/paper.md",
                "contentHash": "a" * 64,
                "verificationState": "partial",
                "freshnessState": "current",
            }]
            active = [{**registered[0], "title": "Active paper"}]

            finalize_research_run(
                workspace,
                run_context=context,
                result_text="Observed a limitation.",
                prompt="Audit source scope.",
                status="completed",
                registered_sources=registered,
                active_sources=active,
            )

            manifest_path = workspace / ".science" / "runs" / context["sessionKey"] / context["runKey"] / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["sourceScope"]["registered"][0]["contentHash"], "a" * 64)
            self.assertEqual(manifest["sourceScope"]["active"][0]["title"], "Active paper")
            self.assertEqual(manifest["sourceScope"]["active"][0]["localLocator"], ".science/sources/paper.md")

    def test_finalize_audits_flate_compressed_pdf_citations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            context = prepare_research_run(
                workspace,
                conversation_id="conversation-compressed-pdf",
                run_id="run-compressed-pdf",
                prompt="Create a PDF.",
                model="deepseek-v4-flash",
            )
            compressed = zlib.compress(b"See https://unregistered.example/compressed")
            (workspace / context["outputDir"] / "report.pdf").write_bytes(
                b"%PDF-1.4\n1 0 obj\n<< /Length " + str(len(compressed)).encode() + b" >>\nstream\n" + compressed + b"\nendstream\n%%EOF"
            )
            result = finalize_research_run(
                workspace,
                run_context=context,
                result_text="PDF written. Limitation: one source.",
                prompt="Create a PDF.",
                status="completed",
                registered_sources=[{"localLocator": ".science/sources/paper.md"}],
                active_sources=[{"localLocator": ".science/sources/paper.md"}],
            )
            self.assertTrue(result["quality"]["blocking"])
            self.assertEqual(
                result["quality"]["outOfBoundaryCitations"],
                ["https://unregistered.example/compressed"],
            )

    def test_finalize_audits_docx_and_pdf_artifact_citations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            context = prepare_research_run(
                workspace,
                conversation_id="conversation-binary-artifacts",
                run_id="run-binary-artifacts",
                prompt="Create deliverables.",
                model="deepseek-v4-flash",
            )
            output_dir = workspace / context["outputDir"]
            with zipfile.ZipFile(output_dir / "report.docx", "w") as archive:
                archive.writestr("word/document.xml", "<w:document><w:t>https://unregistered.example/docx</w:t></w:document>")
            (output_dir / "report.pdf").write_bytes(b"%PDF-1.4\nhttps://unregistered.example/pdf\n%%EOF")

            result = finalize_research_run(
                workspace,
                run_context=context,
                result_text="Deliverables written. Limitation: one source.",
                prompt="Create deliverables.",
                status="completed",
                registered_sources=[{"localLocator": ".science/sources/paper.md"}],
                active_sources=[{"localLocator": ".science/sources/paper.md"}],
            )
            self.assertTrue(result["quality"]["blocking"])
            self.assertEqual(
                set(result["quality"]["outOfBoundaryCitations"]),
                {"https://unregistered.example/docx", "https://unregistered.example/pdf"},
            )

    def test_finalize_marks_a_run_failed_when_evidence_leaves_the_active_source_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            context = prepare_research_run(
                workspace,
                conversation_id="conversation-source-gate",
                run_id="run-source-gate",
                prompt="Use only the active source set.",
                model="deepseek-v4-flash",
            )
            ledger = workspace / context["evidencePath"]
            ledger.write_text(json.dumps({
                "claim": "Out-of-boundary claim",
                "source": "inactive.md",
                "locator": "line 1",
                "quote": "evidence",
                "confidence": "high",
                "addedAt": "2026-11-20T00:00:00+00:00",
            }) + "\n", encoding="utf-8")

            result = finalize_research_run(
                workspace,
                run_context=context,
                result_text="Observed in [1]. Limitation: one source.",
                prompt="Use only the active source set.",
                status="completed",
                registered_sources=[
                    {"localLocator": ".science/sources/paper.md"},
                    {"localLocator": ".science/sources/inactive.md"},
                ],
                active_sources=[{"localLocator": ".science/sources/paper.md"}],
            )
            self.assertTrue(result["quality"]["blocking"])
            manifest_path = workspace / ".science" / "runs" / context["sessionKey"] / context["runKey"] / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "failed")
            self.assertIn("Active Source Set", manifest["error"])


if __name__ == "__main__":
    unittest.main()
