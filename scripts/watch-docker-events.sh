#!/usr/bin/env bash
# ============================================================
# docker-wxchat —— docker events 常驻留痕（「谁停了容器」的黑匣子）
#
# 为什么需要它：
#   diagnose-unexpected-stop.sh 用 `docker events --since` 做事后回溯，
#   但事件缓冲是 daemon 的**内存态** —— daemon 一重启（而这本身正是
#   「所有容器同时收到 SIGTERM」的头号嫌疑之一），缓冲就被清空：
#   你想查它，它先毁尸灭迹。
#
#   本脚本把事件流持续落盘：所有容器的 create / start / die / stop /
#   kill / oom / destroy / prune 事件，连同时间戳、容器名、镜像、退出码、
#   信号量，全部追加进一个日志文件。daemon 重启只会在日志里留下
#   「断开 / 重连」标记，历史不丢 —— 而成串的断开标记本身就是证据。
#
# 用法（在宿主机上、仓库目录里执行）：
#   bash scripts/watch-docker-events.sh                  # 前台运行，Ctrl+C 停止
#   sudo bash scripts/watch-docker-events.sh install     # 装成 systemd 服务（开机自启，推荐）
#   sudo bash scripts/watch-docker-events.sh uninstall   # 卸载（日志文件保留）
#
# 日志位置：root 默认 /var/log/docker-events-journal.log，
#           普通用户为当前目录 ./docker-events-journal.log，
#           可用环境变量 EVENTS_LOG 覆盖。
#
# 事发后怎么读（时间戳是 epoch 秒，date -d @1730000000 换算）：
#   # 谁、几点、怎么死的：
#   grep -E '\| (die|stop|kill|oom) ' /var/log/docker-events-journal.log
#   # 「成批停止」验证：同一秒内 die 的容器数 >= 2 即成立
#   grep ' | die ' /var/log/docker-events-journal.log | awk '{print $1}' | sort | uniq -c | sort -rn | head
#
# 读事件的要点：
#   · exit=143 → 收到 SIGTERM 后正常退出（外部主动停止）；137 = SIGKILL（强杀/OOM，对照 oom 事件）
#   · 出现 kill/stop = 有「人」显式停它（docker stop / compose down / daemon 关机前清理）
#   · 只有 die、前后没有 kill/stop，或整段直接跟着「断开」标记 → daemon 硬杀/断电一类
#   · 带 [journal] 的行是脚本自身状态：「事件流断开/重连」= daemon 在那一刻重启或不可用
# ============================================================

set -u

FMT='{{.Time}} | {{.Action}} | name={{.Actor.Attributes.name}} | image={{index .Actor.Attributes "image"}} | exit={{index .Actor.Attributes "exitCode"}} | signal={{index .Actor.Attributes "signal"}}'
UNIT=/etc/systemd/system/docker-events-journal.service

die() { echo "✗ $*" >&2; exit 1; }

default_out() {
  if [ "$(id -u)" -eq 0 ]; then
    echo /var/log/docker-events-journal.log
  else
    echo ./docker-events-journal.log
  fi
}

marker() {
  printf '%s [journal] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$EVENTS_LOG"
}

do_run() {
  command -v docker >/dev/null 2>&1 || die "找不到 docker 命令。请在宿主机（装了 docker 的机器）上运行。"
  [ -n "${EVENTS_LOG:-}" ] || EVENTS_LOG="$(default_out)"
  touch "$EVENTS_LOG" 2>/dev/null || die "无法写日志文件 $EVENTS_LOG（用 EVENTS_LOG=路径 指定别的位置，或用 sudo 运行）"

  # 防呆：systemd 服务已在跑时，别再开第二个，避免同一条事件写两遍
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet docker-events-journal 2>/dev/null; then
    echo "⚠ systemd 服务 docker-events-journal 已在运行，无需再前台跑一份（会重复记录）。"
    echo "  查看日志：tail -f $EVENTS_LOG"
    exit 0
  fi

  echo "开始留痕 → $EVENTS_LOG（Ctrl+C 停止）"
  marker "journal 启动（pid $$），落盘：$EVENTS_LOG"
  ERRF="${EVENTS_LOG}.lasterr"
  while :; do
    if ! docker info >/dev/null 2>&1; then
      marker "docker daemon 不可达，等待恢复……（恢复后会写一条「daemon 恢复」）"
      until docker info >/dev/null 2>&1; do sleep 5; done
      marker "docker daemon 恢复，重新挂上事件流"
    fi
    docker events \
      --filter 'type=container' \
      --filter 'event=create'  --filter 'event=start' \
      --filter 'event=die'     --filter 'event=stop' \
      --filter 'event=kill'    --filter 'event=oom' \
      --filter 'event=destroy' --filter 'event=prune' \
      --format "$FMT" >>"$EVENTS_LOG" 2>"$ERRF"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      reason=$(head -c 300 "$ERRF" 2>/dev/null | tr '\n' ' ')
      marker "事件流断开（docker events 退出码 $rc${reason:+，docker 说: $reason}）—— daemon 重启/停止的典型特征，自动重连中"
    else
      marker "事件流断开（正常返回）—— daemon 重启/停止的典型特征，自动重连中"
    fi
    sleep 5
  done
}

do_install() {
  [ "$(id -u)" -eq 0 ] || die "install 需要 root：sudo bash $0 install"
  command -v systemctl >/dev/null 2>&1 || die "本机没有 systemd。可用前台方式常驻：nohup bash $0 run >/dev/null 2>&1 &"
  command -v docker >/dev/null 2>&1 || die "找不到 docker 命令。"
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  [ -n "${EVENTS_LOG:-}" ] || EVENTS_LOG="$(default_out)"
  mkdir -p "$(dirname "$EVENTS_LOG")"

  cat >"$UNIT" <<EOF
[Unit]
Description=docker events 持续留痕（docker-wxchat：记录谁停了容器）
# 只排启动顺序，刻意不写 Requires：daemon 重启时本服务要活着，
# 把「断开/重连」标记写进日志 —— 这些标记本身就是证据。
After=docker.service

[Service]
Type=simple
Environment=EVENTS_LOG=$EVENTS_LOG
ExecStart=$SELF run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now docker-events-journal.service
  echo "✓ 已安装并启动：docker-events-journal.service"
  echo "  日志文件 : $EVENTS_LOG"
  echo "  实时查看 : journalctl -u docker-events-journal -f  或  tail -f $EVENTS_LOG"
  echo "  事发回看 : grep -E '\\| (die|stop|kill|oom) ' $EVENTS_LOG | tail -50"
  sleep 2
  systemctl --no-pager status docker-events-journal.service 2>/dev/null | head -8 || true
}

do_uninstall() {
  [ "$(id -u)" -eq 0 ] || die "uninstall 需要 root：sudo bash $0 uninstall"
  if [ -f "$UNIT" ]; then
    systemctl disable --now docker-events-journal.service 2>/dev/null || true
    rm -f "$UNIT"
    systemctl daemon-reload
    echo "✓ 已卸载。历史日志保留在 ${EVENTS_LOG:-/var/log/docker-events-journal.log}"
    echo "  （那是证据，查清根因之前别删。）"
  else
    echo "未安装（找不到 $UNIT）。"
  fi
}

case "${1:-run}" in
  run)       do_run ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
  *) echo "用法: bash $0 [run|install|uninstall]"; exit 2 ;;
esac
