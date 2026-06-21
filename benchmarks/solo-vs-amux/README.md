# Solo vs Amux Benchmark

Compare solo-agent and amux-team workflows on quality-per-token for realistic multi-file tasks.

## Quick Start

```bash
# 1. Prepare workspace
benchmarks/solo-vs-amux/bench.sh prepare

# 2. Set up a solo run for task 1
benchmarks/solo-vs-amux/bench.sh run-solo 1

# 3. Set up an amux run for task 1
benchmarks/solo-vs-amux/bench.sh run-amux 1

# 4. After running each arm, collect results
benchmarks/solo-vs-amux/bench.sh collect solo 1
benchmarks/solo-vs-amux/bench.sh collect amux 1

# 5. Generate report
benchmarks/solo-vs-amux/bench.sh report
```

## How It Works

The harness creates **isolated git clones** at a fixed base commit. Each arm gets its own workspace that never mutates the source repo.

**Solo arm**: A single agent receives the task description and works independently — discovers the codebase, designs the approach, implements, and tests.

**Amux arm**: Three agents work sequentially:
1. **Architect** reads the codebase and writes a spec/plan (compressed intent)
2. **Developer** implements from the spec without re-reading the full codebase
3. **Reviewer** checks the implementation against the spec and acceptance criteria

## Configuration

Override via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BENCH_ROOT` | `/tmp/amux-bench` | Workspace root |
| `SRC_REPO` | repo root | Source repo to clone |
| `BASE_COMMIT` | `HEAD` | Starting commit for all arms |
| `PI_BIN` | `pi` | Pi binary path |
| `PI_MODEL` | _(none)_ | Pin model (e.g., `anthropic/claude-sonnet-4`) |
| `PI_THINKING` | _(none)_ | Thinking mode (e.g., `high`) |

## Tasks

See `tasks/` for benchmark task definitions. Each task describes:
- A high-level goal (not pre-scoped file lists)
- Requirements and acceptance criteria
- Scoring rubric

## Token Measurement

The harness collects diffs, test output, and commits. Token measurement is currently **manual** — check your provider's dashboard or Pi session logs.

**Honest measurement order** (from SPEC-10):
1. Exact provider/Pi token usage from session JSON (preferred)
2. Full transcript token estimate
3. Stdout chars/4 as last-resort proxy (clearly labelled)

The report must state which method was used. Do not claim efficiency without exact/fair measurement.

## Analysis & Scoring

- **[scorecard-template.md](scorecard-template.md)** — Copy per run. Quality rubric (0-15), acceptance criteria checklist, token measurement, rework tracking, failure-mode annotations.
- **[analysis-guide.md](analysis-guide.md)** — How to interpret results: failure modes, token measurement caveats, what NOT to claim.
- **[worked-example.md](worked-example.md)** — Lessons from the initial pilot run.

## Limitations

- Runs are manual — the harness prepares workspaces but does not automate Pi invocations.
- Token measurement depends on provider tooling, not the harness.
- Tasks are designed for the amux codebase; results may not generalize.
- The amux arm has coordination overhead; small tasks may not show compression benefit.
- Quality scoring is manual (see `scorecard-template.md`).

## File Layout

```
benchmarks/solo-vs-amux/
  bench.sh                  Harness script
  README.md                 This file
  tasks/                    Task definitions
    task-1.md               Priority field
    task-2.md               Backlog reordering
    task-3.md               Workspace health in progress
  prompt-templates/         Role-specific prompts
    solo.md                 Solo agent prompt
    architect.md            Architect prompt
    developer.md            Developer prompt
    reviewer.md             Reviewer prompt
  scorecard-template.md     Quality scoring rubric and template
  analysis-guide.md         Interpretation guide and failure modes
  worked-example.md         Lessons from initial pilot
```
