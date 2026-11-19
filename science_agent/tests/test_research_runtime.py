from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from science_agent.research_runtime import (
    assess_result,
    extract_research_charter,
    finalize_research_run,
    prepare_research_run,
)


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
        active = [{"localLocator": ".science/sources/paper.md"}]
        registered = [*active, {"localLocator": ".science/sources/inactive.md"}]
        active_quality = assess_result(
            "Observed in [1]. Limitation: one source.",
            "Summarize the evidence.",
            [],
            1,
            new_evidence_entries=[{"source": "paper.md"}],
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
