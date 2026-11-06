#!/usr/bin/env bash
# 把 agent worktree 的切片套用到目前分支（lead 合併切片用）。不 commit、不刪 worktree。
#
# 用法（在要接收切片的工作目錄執行，通常是主工作目錄）：
#   .claude/scripts/merge-slice.sh <worktree> <base-commit>    套用切片
#   .claude/scripts/merge-slice.sh --cleanup <worktree> [<base-commit>]
#       刪掉 worktree 與它的 worktree-agent-* 分支；只在 worktree 相對 base 沒有改動，
#       或切片的每個改動都已在目前工作目錄（已套用）時才刪。base 省略時用兩邊 HEAD 的 merge-base。
#
# 套用的做法：
#   1. git -C <worktree> add -A（含新檔與 worktree 裡的 commit；會改 worktree 的 index，不改檔案內容）
#   2. git -C <worktree> diff --cached --binary <base>，排除 samples/large-1000.txt，在這裡 git apply --3way
#   3. .gitattributes 標 -text 的檔案（例如 CRLF 的報表 fixture）不進 patch，改為直接複製 worktree 的檔案：
#      patch 套用時以接收端的 .gitattributes 轉換行尾，切片若同時新增 fixture 與 -text 規則，CRLF 會被轉成 LF。
#      -text 依 worktree 的 .gitattributes 判斷。兩邊都改過且內容不同時不覆蓋，列為衝突。
# 「已套用」的判斷：patch 能反向套用（git apply --check -R，逐檔），-text 檔案則內容相同。
#   所以兩邊都改過、已 3-way 合併的檔案也算已套用。
# 輸出：與目前分支（相對同一個 base）都改過的檔案、衝突檔案、成功或失敗。
# 結束碼：成功 0、衝突或失敗 1、參數錯誤 2。
# 可在 macOS（bash 3.2、BSD 工具）與 Linux 執行；不用 mapfile、關聯陣列與 GNU 專有參數。檔名不可含換行。
set -u

die() { echo "錯誤：$*" >&2; exit 2; }
usage() { sed -n '4,8p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
EXCLUDE=':(exclude)samples/large-1000.txt'
nul_to_lines() { tr '\0' '\n'; }
exists() { [ -e "$1" ] || [ -L "$1" ]; }
same_content() { # <檔案A> <檔案B>：兩邊都不存在也算相同
  if exists "$1"; then exists "$2" && cmp -s "$1" "$2"; else ! exists "$2"; fi
}

# 共用準備：解析參數、產生 $TMP/changed（切片改動的檔案）、$TMP/raw（其中 -text 的）、$TMP/slice.patch（其餘）
prepare() { # <worktree> <base 或空字串>
  W=$(cd "$1" 2>/dev/null && pwd -P) || die "找不到 worktree：$1"
  git -C "$W" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "不是 git 工作目錄：$W"
  HERE=$(git rev-parse --show-toplevel 2>/dev/null) || die "目前不在 git 工作目錄"
  HERE=$(cd "$HERE" && pwd -P)
  [ "$W" != "$HERE" ] || die "worktree 與目前工作目錄相同"
  BASE=$2
  if [ -z "$BASE" ]; then BASE=$(git merge-base HEAD "$(git -C "$W" rev-parse HEAD)") || die "找不到 merge-base，請指定 base"; fi
  git rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "目前的 repo 找不到 base：$BASE"
  git -C "$W" rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "worktree 找不到 base：$BASE"
  cd "$HERE" || die "無法進入 $HERE"
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/merge-slice.XXXXXX") || die "無法建立暫存目錄"
  trap 'rm -rf "$TMP"' EXIT
  git -C "$W" add -A -- . "$EXCLUDE" || die "git add -A 失敗：$W"
  git -C "$W" -c core.quotepath=false diff --cached --no-renames --name-only -z "$BASE" -- . "$EXCLUDE" | nul_to_lines > "$TMP/changed"
  : > "$TMP/raw"
  if [ -s "$TMP/changed" ]; then
    git -C "$W" -c core.quotepath=false check-attr text --stdin < "$TMP/changed" | sed -n 's/: text: unset$//p' > "$TMP/raw"
  fi
  set -- . "$EXCLUDE"
  while IFS= read -r f; do [ -n "$f" ] && set -- "$@" ":(exclude,literal)$f"; done < "$TMP/raw"
  git -C "$W" diff --cached --binary --full-index --no-renames "$BASE" -- "$@" > "$TMP/slice.patch" || die "產生 patch 失敗"
}

if [ "${1:-}" = "--cleanup" ]; then
  [ $# -ge 2 ] && [ $# -le 3 ] || usage
  prepare "$2" "${3:-}"
  PENDING=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if grep -qxF -- "$f" "$TMP/raw"; then
      same_content "$W/$f" "$f" || PENDING="$PENDING  $f"$'\n'
    else
      git apply --check -R --include="$f" "$TMP/slice.patch" 2>/dev/null || PENDING="$PENDING  $f"$'\n'
    fi
  done < "$TMP/changed"
  if [ -n "$PENDING" ]; then
    echo "失敗：worktree 有尚未套用到目前工作目錄的改動，不刪除："
    printf '%s' "$PENDING"
    exit 1
  fi
  BR=$(git -C "$W" symbolic-ref --short -q HEAD || true)
  git worktree remove --force "$W" || { echo "失敗：git worktree remove 失敗"; exit 1; }
  echo "已刪除 worktree：$W"
  case "$BR" in
    worktree-agent-*) git branch -D "$BR" >/dev/null && echo "已刪除分支：$BR" ;;
    "") echo "worktree 是 detached HEAD，沒有分支要刪" ;;
    *) echo "分支 $BR 不是 worktree-agent-*，保留" ;;
  esac
  exit 0
fi

[ $# -eq 2 ] || usage
case "$1" in -*) usage ;; esac
prepare "$1" "$2"
if [ ! -s "$TMP/changed" ]; then echo "worktree 相對 $BASE 沒有改動。"; echo "結果：成功（無改動）"; exit 0; fi

# 目前分支相對 base 改過的檔案（已 commit、未 commit、未追蹤）
{ git -c core.quotepath=false diff --no-renames --name-only -z "$BASE" -- . | nul_to_lines
  git -c core.quotepath=false ls-files --others --exclude-standard -z | nul_to_lines; } | sort -u > "$TMP/mine"
sort -u "$TMP/changed" > "$TMP/theirs"
comm -12 "$TMP/mine" "$TMP/theirs" > "$TMP/shared"

echo "切片改動的檔案：$(grep -c . "$TMP/theirs")（其中 -text 直接複製：$(grep -c . "$TMP/raw")）"
echo "與目前分支都改過的檔案（相對 ${BASE}）："
if [ -s "$TMP/shared" ]; then sed 's/^/  /' "$TMP/shared"; else echo "  （無）"; fi

FAILED=0
: > "$TMP/conflicts"

# 1. 一般檔案：patch＋3-way（成功的檔案會一併加入 index）
if [ -s "$TMP/slice.patch" ]; then
  git apply --3way --whitespace=nowarn "$TMP/slice.patch" 2> "$TMP/apply.err" || FAILED=1
  git -c core.quotepath=false diff --name-only --diff-filter=U -z | nul_to_lines >> "$TMP/conflicts"
  if [ "$FAILED" = 1 ] && [ ! -s "$TMP/conflicts" ]; then
    echo "git apply 失敗，沒有套用任何檔案（常見原因：目前工作目錄的檔案與 index 不同，或兩邊都新增了同名檔案）："
    sed 's/^/  /' "$TMP/apply.err"
  fi
fi

# 2. -text 檔案：直接複製，保留 CRLF 與每個位元組
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if grep -qxF -- "$f" "$TMP/mine" && ! same_content "$W/$f" "$f"; then
    echo "${f}（-text，兩邊內容不同，未複製）" >> "$TMP/conflicts"; continue
  fi
  if exists "$W/$f"; then
    { mkdir -p "$(dirname "$f")" && cp -p "$W/$f" "$f" && git add -- "$f"; } || echo "${f}（複製失敗）" >> "$TMP/conflicts"
  else
    { git rm -q --cached --ignore-unmatch -- "$f" && rm -f -- "$f"; } || echo "${f}（刪除失敗）" >> "$TMP/conflicts"
  fi
done < "$TMP/raw"

echo "衝突檔案："
if [ -s "$TMP/conflicts" ]; then sed 's/^/  /' "$TMP/conflicts"; FAILED=1; else echo "  （無）"; fi
if [ "$FAILED" = 0 ]; then echo "結果：成功（已套用到工作目錄與 index，未 commit）"; exit 0; fi
echo "結果：失敗（處理衝突後再跑測試；worktree 未刪除）"
exit 1
