# Immutable artifacts and append-only evidence

Stage Artifacts are versioned immutably, with a current pointer and content hashes tied to the generating Research Run. Evidence Records are append-only; corrections use `supersedes` and withdrawals use `retracts`. This makes Paper Package versions and scientific corrections auditable. The cost is more storage and UI complexity than in-place editing.