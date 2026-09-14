#!/usr/bin/env bash
# HealthWorker 基线验证：跑仓库自带的全部验证命令，输出可直接粘进审查报告的“验证记录”块。
#
# 用法:
#   scripts/verify-baseline.sh                 # 全部（含 build）
#   scripts/verify-baseline.sh --skip-build    # 跳过 build（最快，不写 dist/）
#   scripts/verify-baseline.sh --keep-logs     # 保留原始日志（默认删除，避免留残留）
#
# 副作用: 仅 dist/（已被 .gitignore 忽略）与 /tmp 下的日志目录。不修改源码、不碰远端资源。
# 退出码: 任一步骤失败则为 1，全部通过为 0。
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ]; then
  echo "错误: 不在 git 仓库内，无法定位仓库根目录" >&2
  exit 2
fi
cd "$ROOT"

PNPM="${HEALTHWORKER_PNPM:-npx pnpm@10.34.5}"
SKIP_BUILD=0
KEEP_LOGS=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --keep-logs) KEEP_LOGS=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

LOGS="$(mktemp -d "${TMPDIR:-/tmp}/healthworker-verify.XXXXXX")"
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
FAILED=0
STEP=0
TOTAL=7
[ "$SKIP_BUILD" -eq 1 ] && TOTAL=6

STATUS_LINES=""
REPORT_ROWS=""

step() {
  local name="$1"; shift
  STEP=$((STEP + 1))
  local label
  label=$(printf '%-22s' "$name")
  local begin now elapsed code
  begin=$(date +%s)
  "$@" >"$LOGS/$STEP.$name.log" 2>&1
  code=$?
  now=$(date +%s); elapsed=$((now - begin))
  if [ "$code" -eq 0 ]; then
    printf '[%d/%d] %s 通过 (%ss)\n' "$STEP" "$TOTAL" "$label" "$elapsed"
    STATUS_LINES="$STATUS_LINES$name=PASS "
  else
    printf '[%d/%d] %s 失败 (exit=%d, %ss)\n' "$STEP" "$TOTAL" "$label" "$code" "$elapsed"
    STATUS_LINES="$STATUS_LINES$name=FAIL "
    FAILED=1
    echo "  --- 输出末尾 ---"
    tail -n 25 "$LOGS/$STEP.$name.log" | sed 's/^/  /'
    echo "  ----------------"
  fi
}

extract() { grep -E "$1" "$2" | tail -n "${3:-1}" | sed 's/[[:space:]]\+/ /g' | sed 's/^ //'; }

echo "HealthWorker 基线验证  ($STARTED_AT)"
echo "仓库: $ROOT"
echo "基线: git status $(git status --porcelain | wc -l | tr -d ' ') 行 / 已跟踪文件 $(git ls-files | wc -l | tr -d ' ') 个"
echo

step typecheck $PNPM typecheck
step lint $PNPM lint
step format:check $PNPM format:check
step test $PNPM test
step test:integration $PNPM test:integration
if command -v python3 >/dev/null 2>&1; then
  step python-unittest python3 -m unittest discover -s tests/skill
else
  STEP=$((STEP + 1))
  echo "[$STEP/$TOTAL] python-unittest      跳过 (未找到 python3)"
  STATUS_LINES="$STATUS_LINES""python-unittest=SKIP "
fi
if [ "$SKIP_BUILD" -eq 0 ]; then
  step build $PNPM build
fi

UNIT_SUMMARY="$(extract 'Tests +[0-9]+ passed' "$LOGS/4.test.log" 2>/dev/null || true)"
INTEGRATION_SUMMARY="$(extract 'Tests +[0-9]+ passed' "$LOGS/5.test:integration.log" 2>/dev/null || true)"
PY_SUMMARY="$(extract 'Ran [0-9]+ tests' "$LOGS/6.python-unittest.log" 2>/dev/null || true)"
BUILD_ASSETS="$(grep -E '^dist/client/(index\.html|assets/.*\.(js|css))' "$LOGS/7.build.log" 2>/dev/null | sed 's/[[:space:]]\+/ /g' || true)"

echo
echo "================ 验证记录（可粘贴到报告）================"
echo "| 命令 | 结果 |"
echo "| --- | --- |"
echo "| \`$PNPM typecheck\` | $(grep -q 'typecheck=PASS' <<<"$STATUS_LINES" && echo 通过 || echo 失败) |"
echo "| \`$PNPM lint\` | $(grep -q 'lint=PASS' <<<"$STATUS_LINES" && echo 通过 || echo 失败) |"
echo "| \`$PNPM format:check\` | $(grep -q 'format:check=PASS' <<<"$STATUS_LINES" && echo 通过 || echo 失败) |"
echo "| \`$PNPM test\` | ${UNIT_SUMMARY:-见日志} |"
echo "| \`$PNPM test:integration\` | ${INTEGRATION_SUMMARY:-见日志} |"
echo "| \`python3 -m unittest discover -s tests/skill\` | ${PY_SUMMARY:-见日志} |"
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "| \`$PNPM build\` | $(grep -q 'build=PASS' <<<"$STATUS_LINES" && echo 通过 || echo 失败) |"
fi
echo
if [ -n "$BUILD_ASSETS" ]; then
  echo "构建产物:"
  echo "$BUILD_ASSETS" | sed 's/^/  /'
fi
echo "========================================================="
echo

if [ "$FAILED" -eq 0 ]; then
  echo "结论: $((TOTAL - $(grep -o 'SKIP' <<<"$STATUS_LINES" | wc -l | tr -d ' ')))/$TOTAL 步骤通过"
else
  echo "结论: 有步骤失败，逐条核对上面输出；不要把失败写成通过" >&2
fi

if [ "$KEEP_LOGS" -eq 1 ]; then
  echo "原始日志: $LOGS"
else
  rm -rf "$LOGS"
  echo "原始日志已清理（需要留存请加 --keep-logs）"
fi
exit "$FAILED"
