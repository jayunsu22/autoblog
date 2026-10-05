#!/usr/bin/env bash
# n8n 외부 점검 — GitHub Actions 에서 5분마다 돈다.
# n8n 이나 DB 가 죽으면 n8n 안에 만든 알림도 같이 죽는다(2026-08-13 DB 볼륨 사고). 그래서 n8n 밖에서 점검한다.
#
# 점검: /healthz (서버) · /healthz/readiness (DB 준비) 매번, 실제 웹훅(partner-info)은 30분에 한 번.
#   웹훅 점검은 매번 하지 않는다 — 실행 기록이 DB 에 쌓여 같은 사고를 부를 수 있다. partner-info 는 읽기 전용이고 응답이 작다.
# 알림: 정상 → 실패로 바뀔 때 '장애', 실패가 이어지면 REMIND_SECS(기본 1시간)마다 '아직 장애', 실패 → 정상이면 '복구'.
#   상태는 STATE_FILE 에 적는다(워크플로우가 캐시로 이어 붙인다). 알림이 나가야 하는 실행만 종료코드 1 — 그래서 GitHub 이메일도 그때만 간다.
# 텔레그램은 TG_TOKEN·TG_CHAT 이 있을 때만 보낸다. 없으면 이메일(종료코드 1)만.
set -u

BASE="${BASE:-https://primary-production-a6fa.up.railway.app}"
STATE="${STATE_FILE:-state.txt}"
TG_API="${TG_API:-https://api.telegram.org}"
REMIND_SECS="${REMIND_SECS:-3600}"
RETRY_SLEEP="${RETRY_SLEEP:-10}"
FORCE_WEBHOOK="${FORCE_WEBHOOK:-0}"
NOW="${NOW_EPOCH:-$(date +%s)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PREV=ok; DOWN_SINCE=0; LAST_REMIND=0
# shellcheck disable=SC1090
[ -f "$STATE" ] && . "$STATE"

kst() { TZ=Asia/Seoul date -d "@$1" '+%m/%d %H:%M'; }

FAILS=()
# probe <이름> <주소> <응답에 있어야 하는 글자>
probe() {
  local name="$1" url="$2" want="$3" code="" try
  for try in 1 2; do
    code=$(curl -sS -m 20 -o "$WORK/body" -w '%{http_code}' "$url" 2>"$WORK/err") || code="연결실패"
    if [ "$code" = "200" ] && grep -q "$want" "$WORK/body"; then
      echo "OK   $name (HTTP 200)"
      return 0
    fi
    [ "$try" = 1 ] && sleep "$RETRY_SLEEP"
  done
  echo "FAIL $name (HTTP $code)"
  FAILS+=("$name — HTTP $code")
  return 1
}

probe "서버(/healthz)" "$BASE/healthz" '"ok"'
probe "DB 준비(/healthz/readiness)" "$BASE/healthz/readiness" '"ok"'

MIN=$(TZ=Asia/Seoul date -d "@$NOW" +%M)
if [ "$FORCE_WEBHOOK" = "1" ] || [ $((10#$MIN % 30)) -lt 5 ]; then
  probe "웹훅(partner-info)" "$BASE/webhook/partner-info" '"success"'
else
  echo "SKIP 웹훅(partner-info) — 30분에 한 번"
fi

send_tg() {
  if [ -z "${TG_TOKEN:-}" ] || [ -z "${TG_CHAT:-}" ]; then
    echo "텔레그램 설정 없음 — 건너뜀"
    return 0
  fi
  # 글자는 표준입력으로 넘긴다 — 명령줄 인자로 주면 환경(윈도우 코드페이지 등)에 따라 한글이 깨질 수 있다
  printf '%s' "$1" | curl -sS -m 20 -o /dev/null -w '텔레그램 HTTP %{http_code}\n' "$TG_API/bot${TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT}" --data-urlencode "text@-" || echo "텔레그램 전송 실패"
}

ALERT=""
if [ "${#FAILS[@]}" -gt 0 ]; then
  LIST=$(printf '\n- %s' "${FAILS[@]}")
  if [ "$PREV" != "down" ]; then
    ALERT=start; DOWN_SINCE="$NOW"; LAST_REMIND="$NOW"
    send_tg "🚨 n8n 점검 실패 ($(kst "$NOW"))${LIST}"
  elif [ $((NOW - LAST_REMIND)) -ge "$REMIND_SECS" ]; then
    ALERT=remind; LAST_REMIND="$NOW"
    send_tg "⚠️ n8n 아직 장애 중 — $(( (NOW - DOWN_SINCE) / 60 ))분째 ($(kst "$DOWN_SINCE") 부터)${LIST}"
  fi
  PREV=down
else
  if [ "$PREV" = "down" ]; then
    ALERT=recover
    send_tg "✅ n8n 복구됨 ($(kst "$NOW")) — 장애 $(( (NOW - DOWN_SINCE) / 60 ))분"
  fi
  PREV=ok; DOWN_SINCE=0; LAST_REMIND=0
fi

printf 'PREV=%s\nDOWN_SINCE=%s\nLAST_REMIND=%s\n' "$PREV" "$DOWN_SINCE" "$LAST_REMIND" > "$STATE"
echo "상태: $PREV · 알림: ${ALERT:-없음}"

# 장애 시작·반복 알림일 때만 실패로 끝낸다(GitHub 이메일이 그때만 가도록). 복구와 평소는 성공.
case "$ALERT" in start|remind) exit 1 ;; *) exit 0 ;; esac
