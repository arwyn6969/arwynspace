# Workflow files staged here for transport

These two YAML files belong at `.github/workflows/`. They are sitting in `ci/`
only because of a GitHub API limitation, not by design.

## Why they are here

A GitHub App without the `workflows` permission cannot write anything under
`.github/workflows/`. The create-tree endpoint returns
`403 Resource not accessible by integration` — and it rejects the *entire* push,
not just the offending file. Everything else in this repository went up through
that same API; these two did not.

## Move them (either way works)

**In the browser**, for each file: open it → pencil icon → change the filename
field to `.github/workflows/check.yml` (or `refresh.yml`) → Commit changes.
GitHub lets a signed-in human write workflow files; only the App is restricted.

**Or locally:**

```bash
git mv ci/check.yml   .github/workflows/check.yml
git mv ci/refresh.yml .github/workflows/refresh.yml
git rm ci/README.md
git commit -m "CI: move workflows into .github/workflows"
git push
```

Delete this directory once they are moved.

## What they do, and why it matters here

`check.yml` runs on every push and pull request: build, then the six test suites
(111 assertions), then the field-mismatch probe, then **two deliberate-break steps**
that reintroduce real historical defects and require the checks to fail on them.
That last part is not ceremony — the first version of the probe passed cleanly
against a client with a known defect restored. A checker nobody has made fail is
not evidence.

`refresh.yml` re-indexes the artwork and holder data daily and commits it. It runs
`npm run check` between build and commit, deliberately **not** `continue-on-error`:
if a rate-limited run produces a snapshot that cannot satisfy the contract, the job
fails and commits nothing, leaving yesterday's good data in place. That guard exists
because a throttled run once wrote a broken leaderboard over a good one.

Until these are moved, neither runs. See `CONTRIBUTING.md`.
