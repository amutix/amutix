#!/usr/bin/env bash
# amux benchmark harness — solo vs amux workflow comparison
# See README.md in this directory for documentation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Configuration (override via environment)
BENCH_ROOT="${BENCH_ROOT:-/tmp/amux-bench}"
SRC_REPO="${SRC_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BASE_COMMIT="${BASE_COMMIT:-$(cd "$SRC_REPO" && git rev-parse HEAD)}"
PI_BIN="${PI_BIN:-pi}"
PI_MODEL="${PI_MODEL:-}"
PI_THINKING="${PI_THINKING:-}"

TASKS_DIR="$SCRIPT_DIR/tasks"
PROMPTS_DIR="$SCRIPT_DIR/prompt-templates"

usage() {
  cat <<EOF
amux benchmark harness — solo vs amux comparison

Usage: bench.sh <command> [args]

Commands:
  prepare             Create isolated benchmark workspace
  run-solo <n>        Set up solo arm workspace for task n
  run-amux <n>        Set up amux (architect/developer/reviewer) arms for task n
  collect <arm> <n>   Collect results after a run (arm: solo|amux)
  report              Generate markdown report from collected results

Environment:
  BENCH_ROOT          Workspace root (default: /tmp/amux-bench)
  SRC_REPO            Source repo path (default: repo root)
  BASE_COMMIT         Starting commit (default: HEAD)
  PI_BIN              Pi binary (default: pi)
  PI_MODEL            Pin model (e.g., anthropic/claude-sonnet-4)
  PI_THINKING         Thinking mode (e.g., high)
EOF
}

cmd_prepare() {
  echo "=== Preparing benchmark workspace ==="
  mkdir -p "$BENCH_ROOT"
  echo "Source repo:  $SRC_REPO"
  echo "Base commit:  $BASE_COMMIT"
  echo "Workspace:    $BENCH_ROOT"
  echo "$BASE_COMMIT" > "$BENCH_ROOT/base-commit.txt"
  echo "$SRC_REPO" > "$BENCH_ROOT/src-repo.txt"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$BENCH_ROOT/prepared-at.txt"
  if [[ -n "$PI_MODEL" ]]; then echo "$PI_MODEL" > "$BENCH_ROOT/model.txt"; fi
  echo ""
  echo "Ready. Next: bench.sh run-solo <n>  or  bench.sh run-amux <n>"
}

cmd_run_solo() {
  local n="$1"
  local task="$TASKS_DIR/task-${n}.md"
  [[ -f "$task" ]] || { echo "Error: $task not found."; exit 1; }

  local dir="$BENCH_ROOT/solo-task-${n}"
  echo "=== Setting up solo arm for task $n ==="
  rm -rf "$dir"
  git clone --no-checkout "$SRC_REPO" "$dir" 2>/dev/null
  (cd "$dir" && git checkout "$BASE_COMMIT" -b bench-solo 2>/dev/null)

  # Assemble prompt
  local prompt="$dir/BENCHMARK_PROMPT.md"
  cat "$PROMPTS_DIR/solo.md" > "$prompt"
  printf '\n## Task\n\n' >> "$prompt"
  cat "$task" >> "$prompt"

  echo ""
  echo "Solo workspace ready:"
  echo "  Dir:    $dir"
  echo "  Prompt: $dir/BENCHMARK_PROMPT.md"
  echo ""
  echo "Run:  cd $dir && ${PI_BIN}"
  echo "Then give the agent the prompt from BENCHMARK_PROMPT.md."
  echo "After: bench.sh collect solo $n"
}

cmd_run_amux() {
  local n="$1"
  local task="$TASKS_DIR/task-${n}.md"
  [[ -f "$task" ]] || { echo "Error: $task not found."; exit 1; }

  for role in architect developer reviewer; do
    local dir="$BENCH_ROOT/amux-${role}-task-${n}"
    echo "Setting up amux $role for task $n..."
    rm -rf "$dir"
    git clone --no-checkout "$SRC_REPO" "$dir" 2>/dev/null
    (cd "$dir" && git checkout "$BASE_COMMIT" -b "bench-${role}" 2>/dev/null)

    local prompt="$dir/BENCHMARK_PROMPT.md"
    cat "$PROMPTS_DIR/${role}.md" > "$prompt"
    printf '\n## Task\n\n' >> "$prompt"
    cat "$task" >> "$prompt"
  done

  echo ""
  echo "=== Amux arms ready for task $n ==="
  echo "  Architect:  $BENCH_ROOT/amux-architect-task-${n}/"
  echo "  Developer:  $BENCH_ROOT/amux-developer-task-${n}/"
  echo "  Reviewer:   $BENCH_ROOT/amux-reviewer-task-${n}/"
  echo ""
  echo "Workflow: architect → developer → reviewer"
  echo "  1. Architect: design approach, write spec, list files/constraints"
  echo "  2. Developer: implement from architect's spec (copy spec to developer workspace)"
  echo "  3. Reviewer:  review developer's diff against spec + tests"
  echo ""
  echo "After: bench.sh collect amux $n"
}

cmd_collect() {
  local arm="$1" n="$2"
  local out="$BENCH_ROOT/results/${arm}-task-${n}"
  mkdir -p "$out"

  if [[ "$arm" == "solo" ]]; then
    local d="$BENCH_ROOT/solo-task-${n}"
    echo "Collecting solo results from $d..."
    (cd "$d" && git diff "$BASE_COMMIT" > "$out/diff.patch" 2>/dev/null || true)
    (cd "$d" && git log --oneline "$BASE_COMMIT"..HEAD > "$out/commits.txt" 2>/dev/null || true)
    (cd "$d" && npm test > "$out/test-output.txt" 2>&1 || true)

  elif [[ "$arm" == "amux" ]]; then
    for role in architect developer reviewer; do
      local d="$BENCH_ROOT/amux-${role}-task-${n}"
      local rd="$out/$role"
      mkdir -p "$rd"
      echo "Collecting $role results..."
      (cd "$d" && git diff "$BASE_COMMIT" > "$rd/diff.patch" 2>/dev/null || true)
      (cd "$d" && git log --oneline "$BASE_COMMIT"..HEAD > "$rd/commits.txt" 2>/dev/null || true)
    done
    local dev="$BENCH_ROOT/amux-developer-task-${n}"
    (cd "$dev" && npm test > "$out/test-output.txt" 2>&1 || true)

  else
    echo "Error: arm must be 'solo' or 'amux'"; exit 1
  fi

  date -u +%Y-%m-%dT%H:%M:%SZ > "$out/collected-at.txt"
  echo "Results collected to $out/"
}

cmd_report() {
  local rpt="$BENCH_ROOT/report.md"
  {
    echo "# Benchmark Report"
    echo ""
    echo "- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "- Base commit: $(cat "$BENCH_ROOT/base-commit.txt" 2>/dev/null || echo unknown)"
    echo "- Model: ${PI_MODEL:-not pinned}"
    echo "- Thinking: ${PI_THINKING:-not set}"
    echo ""

    for rd in "$BENCH_ROOT/results"/*/; do
      [[ -d "$rd" ]] || continue
      local name; name="$(basename "$rd")"
      echo "## $name"
      echo ""

      # Diff stats
      if [[ -f "$rd/diff.patch" ]]; then
        local adds dels
        adds=$(grep -c '^+[^+]' "$rd/diff.patch" 2>/dev/null || echo 0)
        dels=$(grep -c '^-[^-]' "$rd/diff.patch" 2>/dev/null || echo 0)
        echo "Diff: +${adds} -${dels} lines"
      fi

      # Sub-role diffs (amux)
      for sub in "$rd"/architect "$rd"/developer "$rd"/reviewer; do
        [[ -d "$sub" ]] || continue
        local r; r="$(basename "$sub")"
        if [[ -f "$sub/diff.patch" ]]; then
          local sa sd
          sa=$(grep -c '^+[^+]' "$sub/diff.patch" 2>/dev/null || echo 0)
          sd=$(grep -c '^-[^-]' "$sub/diff.patch" 2>/dev/null || echo 0)
          echo "  $r: +${sa} -${sd} lines"
        fi
      done

      # Test results
      if [[ -f "$rd/test-output.txt" ]]; then
        echo ""
        echo "Tests:"
        echo '```'
        tail -8 "$rd/test-output.txt" | grep -E 'tests|pass|fail|suites' | head -5
        echo '```'
      fi

      echo ""
      echo "### Quality Score"
      echo ""
      echo "_TODO: see scorecard-template.md for manual scoring rubric_"
      echo ""
    done
  } > "$rpt"
  echo "Report: $rpt"
}

# ─── Dispatch ─────────────────────────────────────────────────
case "${1:-}" in
  prepare)  cmd_prepare ;;
  run-solo) cmd_run_solo "${2:?Task number required}" ;;
  run-amux) cmd_run_amux "${2:?Task number required}" ;;
  collect)  cmd_collect "${2:?Arm required (solo|amux)}" "${3:?Task number required}" ;;
  report)   cmd_report ;;
  help|--help|-h) usage ;;
  *) usage; exit 1 ;;
esac
