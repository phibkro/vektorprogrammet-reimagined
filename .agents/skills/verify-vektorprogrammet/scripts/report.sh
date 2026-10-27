#!/usr/bin/env bash
# Writes REPORT.md in the run directory: what was verified, at which commit, with which artifacts (sizes and SHA-256).
# Usage: scripts/report.sh [--features "<ids and entry points you drove>"]
# cleanup.sh calls it last, so the report also records the teardown. It is safe to run any time, any number of times.
# Attach REPORT.md, plus the artifacts it lists that matter, to the review.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

features=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --features) features="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

resolve_run_dir
set -a
# shellcheck disable=SC1091
[[ -f "$RUN_DIR/state.env" ]] && . "$RUN_DIR/state.env"
# shellcheck disable=SC1091
[[ -f "$RUN_DIR/meta.env" ]] && . "$RUN_DIR/meta.env"
set +a

summarise_results() { # prints one line per Playwright result file
  local file
  for file in "$RUN_DIR"/results-*.json; do
    [[ -f "$file" ]] || continue
    echo "- \`$(basename "$file")\`: $(RESULTS="$file" in_devenv bun -e '
      const run = JSON.parse(await Bun.file(process.env.RESULTS).text());
      const { expected, unexpected, flaky, skipped } = run.stats;
      const titles = [];
      const walk = (suite) => {
        for (const spec of suite.specs ?? []) titles.push(`${spec.ok ? "pass" : "FAIL"}: ${spec.title}`);
        for (const child of suite.suites ?? []) walk(child);
      };
      run.suites.forEach(walk);
      console.log(`${expected} passed, ${unexpected} failed, ${flaky} flaky, ${skipped} skipped`);
      for (const title of titles) console.log(`  - ${title}`);
    ')"
  done
}

{
  echo "# Verification report"
  echo
  echo "- run: \`$RUN_DIR\`"
  echo "- tree: \`${VERIFY_TREE:-?}\` at \`${REVISION:-?}\` (branch \`${BRANCH:-?}\`)"
  echo "- tree status at launch: $(wc -l <"$RUN_DIR/git-status.txt") changed or untracked paths (\`git-status.txt\`)"
  echo "- started: ${STARTED_AT:-?}; cleaned up: ${CLEANED_AT:-not yet}"
  [[ "${FORCED:-0}" == 1 ]] && echo "- WARNING: launched with VERIFY_FORCE=1; headroom was not checked"
  [[ -n "$features" ]] && echo "- features driven: $features"
  echo "- instance (gone after cleanup): ${E2E_BASE_URL:-?}, CMS ${E2E_CMS_URL:-?}, database \`$(database_of "${E2E_DATABASE_URL:-x://x/?}")\`"
  echo
  echo "## Playwright results"
  summarise_results
  echo
  echo "## Artifacts"
  echo
  echo "| file | bytes | sha256 |"
  echo "| --- | --- | --- |"
  (cd "$RUN_DIR" && find . -type f ! -name secrets.env ! -name REPORT.md ! -name '.storage-*' | sort | while IFS= read -r file; do
    echo "| \`${file#./}\` | $(stat -c %s "$file") | $(sha256sum "$file" | cut -c1-16) |"
  done)
} >"$RUN_DIR/REPORT.md"
echo "saved: $RUN_DIR/REPORT.md"
