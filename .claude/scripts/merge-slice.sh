#!/usr/bin/env bash
# 把 agent worktree 的切片套用到目前分支，或在合併後刪掉 worktree（lead 合併切片用）。
#
# 用法（在要接收切片的工作目錄執行，通常是主工作目錄）：
#   .claude/scripts/merge-slice.sh <worktree> <base-commit>    套用切片（不 commit、不刪 worktree）
#   .claude/scripts/merge-slice.sh --cleanup <worktree> [<base-commit>]
#   .claude/scripts/merge-slice.sh --cleanup-all               逐一處理 .claude/worktrees/ 下的 worktree
#       切片已合併就刪 worktree 與 worktree-agent-* 分支，不必 --force。base 省略時用兩邊 HEAD 的 merge-base。
#       已合併：切片的每個檔案，在目前工作目錄或 base 之後的某個 commit 曾是切片的內容（之後再改過也算）。
#       被鎖住的（agent 執行中）略過並印出鎖的原因；鎖記的 pid 已結束時視為殘留的鎖，解鎖後照常處理。
#       結束碼：全部刪除或略過 0、有未合併或失敗 1、參數錯誤 2；--cleanup 單一 worktree 被略過時 3。
#
# 套用的做法：
#   1. git -C <worktree> add -A（含新檔與 worktree 裡的 commit；會改 worktree 的 index，不改檔案內容）
#   2. git -C <worktree> diff --cached --binary <base>，排除 samples/large-1000.txt，在這裡 git apply --3way
#   3. .gitattributes 標 -text 的檔案（例如 CRLF 的報表 fixture）不進 patch，改為直接複製 worktree 的檔案：
#      patch 套用時以接收端的 .gitattributes 轉換行尾，切片若同時新增 fixture 與 -text 規則，CRLF 會被轉成 LF。
#      -text 依 worktree 的 .gitattributes 判斷。兩邊都改過且內容不同時不覆蓋，列為衝突。
# 「已合併」的判斷（逐檔）：patch 能在目前工作目錄或某個 commit 的樹上反向套用（git apply --check -R），
#   -text 檔案則內容相同。比對內容而不比 commit，所以 lead 合併成一個 commit、兩邊都改過已 3-way 合併的檔案也算。
# 套用的輸出：與目前分支（相對同一個 base）都改過的檔案、衝突檔案、成功或失敗。結束碼：成功 0、衝突或失敗 1、參數錯誤 2。
# 可在 macOS（bash 3.2、BSD 工具）與 Linux 執行；不用 mapfile、關聯陣列與 GNU 專有參數。檔名不可含換行。
set -u

die() { echo "錯誤：$*" >&2; exit 2; }
usage() { sed -n '4,11p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
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
  # 不在 add 加排除：被 gitignore 的檔（例如 gen:large 產生的大檔）本來就不會加入；
  # 對被忽略的路徑下排除 pathspec 反而讓 git add 以錯誤結束。排除只用在後面的 diff。
  git -C "$W" add -A || die "git add -A 失敗：$W"
  git -C "$W" -c core.quotepath=false diff --cached --no-renames --name-only -z "$BASE" -- . "$EXCLUDE" | nul_to_lines > "$TMP/changed"
  : > "$TMP/raw"
  if [ -s "$TMP/changed" ]; then
    git -C "$W" -c core.quotepath=false check-attr text --stdin < "$TMP/changed" | sed -n 's/: text: unset$//p' > "$TMP/raw"
  fi
  set -- . "$EXCLUDE"
  while IFS= read -r f; do [ -n "$f" ] && set -- "$@" ":(exclude,literal)$f"; done < "$TMP/raw"
  git -C "$W" diff --cached --binary --full-index --no-renames "$BASE" -- "$@" > "$TMP/slice.patch" || die "產生 patch 失敗"
}

lock_reason() { # <worktree 的實際路徑>：被鎖住時印出原因並回傳 0
  local cur="" line r
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) cur=$(cd "${line#worktree }" 2>/dev/null && pwd -P) ;;
      locked*) if [ "$cur" = "$1" ]; then r=${line#locked}; r=${r# }; echo "${r:-（未寫原因）}"; return 0; fi ;;
    esac
  done <<< "$(git worktree list --porcelain)"
  return 1
}

# 切片的檔案在 <commit> 的樹上是否為切片的內容（-text 比對 blob，其餘以 patch 反向套用）
applied_in_commit() { # <commit> <檔案>
  if grep -qxF -- "$2" "$TMP/raw"; then
    local blob; blob=$(git rev-parse -q --verify "$1:$2" 2>/dev/null)
    if exists "$W/$2"; then [ "$(git hash-object --no-filters -- "$W/$2")" = "$blob" ]; else [ -z "$blob" ]; fi
  else
    GIT_INDEX_FILE="$TMP/index" git apply --cached --check -R --include="$2" "$TMP/slice.patch" 2>/dev/null
  fi
}

cleanup_one() { # <worktree> <base 或空字串>；結束碼：刪除 0、未合併或失敗 1、略過 3
  local real R PID C f BR
  real=$(cd "$1" 2>/dev/null && pwd -P) || die "找不到 worktree：$1"
  if R=$(lock_reason "$real"); then
    PID=$(printf '%s\n' "$R" | sed -n 's/.*pid \([0-9][0-9]*\).*/\1/p')
    if [ -n "$PID" ] && ! ps -p "$PID" >/dev/null 2>&1; then
      echo "解鎖：${real}（鎖的程序 $PID 已結束：${R}）"
      git worktree unlock "$real" || { echo "失敗：無法解鎖 $real"; return 1; }
    else
      echo "略過：${real} 被鎖住（${R}）。agent 可能還在執行；確定已結束時先 git worktree unlock 再執行"
      return 3
    fi
  fi
  prepare "$1" "$2"   # 在鎖的判斷之後：prepare 會 git add -A，不能動到執行中 agent 的 index
  # 先比對目前工作目錄（剛套用、未 commit），再由新到舊比對 base 之後的 commit
  : > "$TMP/pending"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if grep -qxF -- "$f" "$TMP/raw"; then same_content "$W/$f" "$f" && continue
    else git apply --check -R --include="$f" "$TMP/slice.patch" 2>/dev/null && continue; fi
    echo "$f" >> "$TMP/pending"
  done < "$TMP/changed"
  for C in $(git rev-list HEAD "^$BASE"); do
    [ -s "$TMP/pending" ] || break
    GIT_INDEX_FILE="$TMP/index" git read-tree "$C" || { echo "失敗：無法讀取 $C 的樹"; return 1; }
    : > "$TMP/next"
    while IFS= read -r f; do applied_in_commit "$C" "$f" || echo "$f" >> "$TMP/next"; done < "$TMP/pending"
    mv "$TMP/next" "$TMP/pending"
  done
  if [ -s "$TMP/pending" ]; then
    echo "失敗：$W 有改動不在目前工作目錄，也不在 ${BASE} 之後的任何 commit，不刪除："
    sed 's/^/  /' "$TMP/pending"
    return 1
  fi
  BR=$(git -C "$W" symbolic-ref --short -q HEAD || true)
  git worktree remove --force "$W" || { echo "失敗：git worktree remove 失敗：$W"; return 1; }
  echo "已刪除 worktree：$W"
  case "$BR" in
    worktree-agent-*) git branch -D "$BR" >/dev/null && echo "已刪除分支：$BR" ;;
    "") echo "worktree 是 detached HEAD，沒有分支要刪" ;;
    *) echo "分支 $BR 不是 worktree-agent-*，保留" ;;
  esac
  return 0
}

if [ "${1:-}" = "--cleanup" ]; then
  [ $# -ge 2 ] && [ $# -le 3 ] || usage
  cleanup_one "$2" "${3:-}"
  exit $?
fi

if [ "${1:-}" = "--cleanup-all" ]; then
  [ $# -eq 1 ] || usage
  TOP=$(git rev-parse --show-toplevel 2>/dev/null) || die "目前不在 git 工作目錄"
  TOP=$(cd "$TOP" && pwd -P)
  # 只處理主工作目錄的 .claude/worktrees/ 底下（git worktree list 的第一筆是主工作目錄）
  MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
  MAIN=$(cd "$MAIN" && pwd -P)
  DONE=0; SKIPPED=0; FAILED=0
  LIST=$(git worktree list --porcelain | sed -n 's/^worktree //p')
  while IFS= read -r p; do
    p=$(cd "$p" 2>/dev/null && pwd -P) || continue
    case "$p" in "$MAIN"/.claude/worktrees/*) ;; *) continue ;; esac
    [ "$p" != "$TOP" ] || { echo "略過：$p 是目前工作目錄"; SKIPPED=$((SKIPPED + 1)); continue; }
    ( cleanup_one "$p" "" ) </dev/null
    case $? in 0) DONE=$((DONE + 1)) ;; 3) SKIPPED=$((SKIPPED + 1)) ;; *) FAILED=$((FAILED + 1)) ;; esac
  done <<< "$LIST"
  echo "結果：刪除 ${DONE}、略過 ${SKIPPED}、未合併或失敗 $FAILED"
  [ "$FAILED" = 0 ] || exit 1
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
