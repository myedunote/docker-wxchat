#!/usr/bin/env bash
# ============================================================
# docker-wxchat —— 「容器启动后不久就停止」故障诊断
#
# 用法（在宿主机上、有 docker-compose.yml 的目录里执行）：
#   bash scripts/diagnose-unexpected-stop.sh
#
# 这个脚本回答的唯一问题是：**到底是谁让容器停下来的**。
#
# 先建立一个判断：
#   日志里出现 `收到 SIGTERM，开始优雅关闭…` + 后续完整的关闭流程，
#   说明**应用本身是好的** —— SIGTERM 是外部发来的信号，不是程序崩溃。
#   真正要查的是「谁发的信号」，而这个问题的答案不在容器里，在宿主机上。
#
# 第二个判断更关键：
#   如果**同一台机器上的其它容器也同时停了**，那就基本可以排除单容器问题。
#   能一次性停掉一批容器的，只有下面这几种：
#     · docker daemon 重启（含 OOM 崩溃后被 systemd 拉起、apt 升级 docker）
#     · 宿主机重启 / 关机 / 云厂商回收实例
#     · 有人或某个面板执行了 docker compose down / docker stop $(docker ps -q)
#     · 磁盘写满导致 daemon 无法继续工作
#     · 整机内存耗尽，内核 OOM killer 挑进程杀
#   本脚本逐条去查。
# ============================================================

set -uo pipefail

CONTAINER="${CONTAINER:-wxchat}"
SERVICE="${SERVICE:-wxchat}"
PROJECT="${PROJECT:-}"

hr() { printf '%s\n' "------------------------------------------------------------"; }
title() { echo; echo "== $1 =="; }
VERDICT=()

# docker compose 的项目名（用于列同项目容器）；拿不到就留空
compose_project() {
  if [ -n "$PROJECT" ]; then echo "$PROJECT"; return; fi
  local p
  p=$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
  [ "$p" = "<no value>" ] && p=""
  echo "$p"
}

# ---------------------------------------------------------------
title "0. 环境"
DOCKER_OK=1
if command -v docker >/dev/null 2>&1; then
  echo "docker      : $(docker --version 2>/dev/null || echo '命令存在但无法执行')"
  echo "compose     : $(docker compose version 2>/dev/null || echo '不可用')"
  docker info >/dev/null 2>&1 || { echo "  ⚠ docker 命令存在，但连不上 daemon"; DOCKER_OK=0; }
else
  echo "docker      : 不可用（未安装或不在 PATH）"
  DOCKER_OK=0
fi
echo "宿主机      : $(uname -srm 2>/dev/null || uname -a)"
echo "当前目录    : $(pwd)"
if [ "$DOCKER_OK" -eq 0 ]; then
  echo
  echo "本脚本需要访问 docker daemon。请在运行容器的宿主机上执行。"
  echo "（第 3、4、5 节不依赖 docker，仍然有效。）"
fi

# ---------------------------------------------------------------
title "1. 容器自己的「死亡记录」"
# .State.OOMKilled 与 .State.ExitCode 是两个最有信息量的字段：
#   137 = 128+9  → 被 SIGKILL（OOM、或 stop 超时后被强杀）
#   143 = 128+15 → 被 SIGTERM 正常停止（Docker 的常规停止路径）
#   0            → 进程自己退出且返回成功（对常驻服务来说不正常）
if [ "$DOCKER_OK" -eq 0 ]; then
  echo "  （跳过：docker 不可用）"
elif docker inspect "$CONTAINER" >/dev/null 2>&1; then
  docker inspect "$CONTAINER" --format '  状态            = {{.State.Status}}
  退出码 ExitCode = {{.State.ExitCode}}
  OOMKilled       = {{.State.OOMKilled}}
  重启次数        = {{.RestartCount}}
  启动时间        = {{.State.StartedAt}}
  停止时间        = {{.State.FinishedAt}}
  重启策略        = {{.HostConfig.RestartPolicy.Name}}
  内存限制        = {{if .HostConfig.Memory}}{{.HostConfig.Memory}}{{else}}(未设置){{end}}
  日志驱动        = {{.HostConfig.LogConfig.Type}}
  日志选项        = {{json .HostConfig.LogConfig.Config}}
  项目            = {{index .Config.Labels "com.docker.compose.project"}}'

  EXITCODE=$(docker inspect "$CONTAINER" --format '{{.State.ExitCode}}' 2>/dev/null || echo '?')
  OOMKILLED=$(docker inspect "$CONTAINER" --format '{{.State.OOMKilled}}' 2>/dev/null || echo '?')
  RESTARTS=$(docker inspect "$CONTAINER" --format '{{.RestartCount}}' 2>/dev/null || echo '0')
  LOGDRIVER=$(docker inspect "$CONTAINER" --format '{{.HostConfig.LogConfig.Type}}' 2>/dev/null || echo '?')
  LOGSIZE_OPT=$(docker inspect "$CONTAINER" --format '{{index .HostConfig.LogConfig.Config "max-size"}}' 2>/dev/null || true)

  echo
  case "$EXITCODE" in
    143) echo "  → 143 = 128+15，进程收到 SIGTERM 后正常退出。"
         echo "    这是 Docker 的标准停止路径，**应用侧没有问题**，信号来自外部。"
         VERDICT+=("退出码 143（SIGTERM）：应用是被外部正常停止的，不是崩溃。重点查「谁发的信号」（见第 2、4、6 节）") ;;
    137) echo "  → 137 = 128+9，进程被 SIGKILL 强杀。"
         if [ "$OOMKILLED" = "true" ]; then
           echo "    且 OOMKilled=true → 容器内存超限，被内核杀掉。"
           echo "    这种死法**不会留下任何应用日志**，所以「日志里没报错」不代表没问题。"
           VERDICT+=("容器因内存超限被 OOM 杀掉（exit 137 + OOMKilled=true）。加大内存限制，或压低 Node 堆上限（启动日志里有『Node 堆上限』一行）")
         else
           echo "    但 OOMKilled=false → 多半是 docker stop 的宽限期（默认 10s）内没退完，被强杀。"
           echo "    本项目的 stop_grace_period 是 15s，正常情况不会走到这一步；"
           echo "    若反复出现，检查是否有大量 SSE 长连接卡住了关闭流程。"
         fi ;;
    0)   echo "  → 退出码 0：进程主动正常退出。" ;;
    *)   echo "  → 退出码 $EXITCODE" ;;
  esac

  if [ "$RESTARTS" != "0" ] && [ "$RESTARTS" != "?" ]; then
    echo "  ⚠ 该容器已重启 $RESTARTS 次 —— 说明是**反复**停止，不是偶发。"
  fi

  # 本次运行了多久？
  # 「跑了 30 秒就停」和「跑了 3 天才停」指向完全不同的原因，这是最省事的一条分流线：
  #   短（< 2 分钟）→ 多半有东西在**定期**重新部署/重启，而不是内存或负载问题
  #   长（数小时~数天）→ 更可能是宿主级偶发事件（daemon 重启 / 关机 / OOM）
  RUNSEC=""
  S_AT=$(docker inspect "$CONTAINER" --format '{{.State.StartedAt}}' 2>/dev/null || echo '')
  F_AT=$(docker inspect "$CONTAINER" --format '{{.State.FinishedAt}}' 2>/dev/null || echo '')
  if [ -n "$S_AT" ] && [ -n "$F_AT" ]; then
    S_EPOCH=$(date -d "$S_AT" +%s 2>/dev/null || echo '')
    F_EPOCH=$(date -d "$F_AT" +%s 2>/dev/null || echo '')
    if [ -n "$S_EPOCH" ] && [ -n "$F_EPOCH" ] && [ "$F_EPOCH" -ge "$S_EPOCH" ] 2>/dev/null; then
      RUNSEC=$((F_EPOCH - S_EPOCH))
      echo "  本次运行时长    = ${RUNSEC} 秒"
      if [ "$RUNSEC" -lt 120 ]; then
        echo "  ⚠ 运行不到 2 分钟就被停。这种「刚起来就被停」的短周期，"
        echo "    典型来源是**定时任务 / 面板的定期重新部署**（cron、systemd timer、"
        echo "    1Panel / 宝塔 / 群晖 / Portainer 的自动部署），而不是内存或负载。"
        echo "    请重点看第 2b 节的「成批停止」判定和第 7 节的定时任务检查。"
        VERDICT+=("容器只运行了 ${RUNSEC} 秒就被 SIGTERM → 优先查「定期重新部署」（crontab / systemd timer / 面板自动部署），而不是 OOM")
      fi
    fi
  fi

  # 容器当前是不是「被显式停掉、且不会自己回来」的状态
  ST=$(docker inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null || echo '?')
  if [ "$ST" = "exited" ] && [ "$EXITCODE" = "0" ]; then
    echo
    echo "  容器当前是 exited(0)：进程是被**显式停止**的，不是崩溃。"
    echo "  注意 restart 策略的边界："
    echo "    · unless-stopped —— 被手动 stop 过就不会自己回来"
    echo "    · always        —— 手动 stop 后，只在 **docker daemon 重启**时才回来"
    echo "  两者都**扛不住** docker stop / compose down / 宿主机保持关机。"
  elif [ "$ST" = "restarting" ]; then
    echo
    echo "  容器处于 restarting：正在反复重启。看上面的退出码判断死因。"
  fi

  # 日志轮转是否生效 —— 这是判断「磁盘被日志撑满」的前提
  echo
  if [ "$LOGDRIVER" = "json-file" ] && [ -z "${LOGSIZE_OPT:-}" ]; then
    echo "  ✗ 日志驱动是 json-file，但**没有设置 max-size** → 日志无限增长。"
    echo "    长期运行会把 /var/lib/docker 所在分区撑满，进而影响同机器上的所有容器。"
    echo "    处置：更新到最新版 docker-compose.yml（已默认开启 10m × 3 轮转）后"
    echo "          docker compose up -d"
    VERDICT+=("容器日志没有大小上限（json-file + 无 max-size）。请拉取最新 compose 并 docker compose up -d")
  elif [ "$LOGDRIVER" = "json-file" ]; then
    echo "  ✓ 日志已开启轮转（max-size=$LOGSIZE_OPT）"
  else
    echo "  · 日志驱动为 $LOGDRIVER（非 json-file），不受磁盘撑满影响"
  fi
else
  echo "  容器 '$CONTAINER' 不存在。"
  echo "  若你改了 container_name，请用环境变量指定：CONTAINER=你的容器名 bash $0"
fi

# ---------------------------------------------------------------
title "2. 到底是谁发的停止信号（docker events 回溯）"
# events 是最直接的证据：谁调用、什么事件、什么时间，一目了然。
# 默认只看最近 24 小时，可用 SINCE 覆盖：SINCE='48h' bash $0
SINCE="${SINCE:-24h}"
if [ "$DOCKER_OK" -eq 0 ]; then
  echo "  （跳过：docker 不可用）"
else
  echo "  时间窗：最近 $SINCE"
  echo
  EV=$(docker events --since "$SINCE" --until 0s \
        --filter "container=$CONTAINER" \
        --format '{{.Time}}  {{.Action}}  ({{.Type}})' 2>/dev/null | tail -40 || true)
  if [ -z "$EV" ]; then
    echo "  （该时间窗内没有事件。daemon 重启会清空事件缓冲，这本身就是线索。）"
    echo "  换个更长的窗口再试：SINCE='7d' bash $0"
  else
    echo "$EV" | sed 's/^/  /'
    echo
    echo "  怎么读："
    echo "    · stop / kill 前紧跟着 daemon 级事件 → daemon 或宿主机发起的停止"
    echo "    · oom 事件                          → 内存超限被杀（与第 1 节 OOMKilled 互相印证）"
    echo "    · 同一时刻**多个不同容器**都有 die/stop → 宿主机层面事件（第 4、6 节）"
  fi

  # 全局事件里看「同一时刻还有谁一起死了」—— 这是「其它容器也停」的直接证据
  echo
  echo "  同一时间窗内，**所有**容器的 die/stop/kill/oom 事件（看是否成批出现）："
  ALLEV=$(docker events --since "$SINCE" --until 0s \
        --filter 'event=die' --filter 'event=stop' --filter 'event=kill' --filter 'event=oom' \
        --format '{{.Time}}  {{.Action}}  {{.Actor.Attributes.name}}' 2>/dev/null | tail -30 || true)
  if [ -z "$ALLEV" ]; then
    echo "    （无）"
  else
    echo "$ALLEV" | sed 's/^/    /'
    CNT=$(echo "$ALLEV" | awk '{print $1}' | sort -u | wc -l | tr -d ' ')
    echo
    if [ "$CNT" -le 1 ] && [ "$(echo "$ALLEV" | wc -l | tr -d ' ')" -gt 1 ]; then
      echo "    → 多个容器的停止事件集中在同一秒/同一时刻，这是**宿主机级操作**的典型特征。"
      VERDICT+=("多个容器在同一时刻被停止 → 宿主机级事件（daemon 重启 / 宿主机重启 / 批量 stop）。见第 4、6 节")
    fi
  fi
fi

# ---------------------------------------------------------------
title "2b. 时间线对照：是不是「成批停止」（最决定性的一节）"
#
# 「其它容器也一起停」是用户的口头描述，这里把它变成**硬时间戳**：
# 把所有容器的 FinishedAt 列出来。如果两个以上容器的停止时间落在**同一秒**，
# 那就不是巧合 —— 一定是某个东西在统一指挥，宿主机级事件或批量命令。
# 反之，如果各容器的停止时间零零散散，那「一起停」的说法就不成立，要回头查单容器原因。
if [ "$DOCKER_OK" -eq 0 ]; then
  echo "  （跳过：docker 不可用）"
else
  echo "  各容器的时间线（停于 = FinishedAt，只统计真正停过的）："
  echo
  # 表头手工对齐：中文在终端里占两列，用 printf 的 %-Ns 会算错宽度，所以直接写字面量
  echo "    容器                     状态       退出码   停于                   启动于"
  docker ps -a --format '{{.Names}}' 2>/dev/null | while read -r n; do
    [ -z "$n" ] && continue
    docker inspect "$n" --format \
      '{{.Name}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.FinishedAt}}|{{.State.StartedAt}}' \
      2>/dev/null | awk -F'|' '{
        gsub(/^\//, "", $1);
        fin = ($4 ~ /^0001-01-01/) ? "(未停过)" : substr($4, 1, 19);
        st  = ($5 ~ /^0001-01-01/) ? "(未启动)" : substr($5, 1, 19);
        printf "    %-24s %-10s %-8s %-22s %s\n", $1, $2, $3, fin, st;
      }'
  done

  echo
  echo "  停止时间**落在同一秒**的容器（计数 >= 2 即为成批停止）："
  CLUSTER=$(docker ps -a --format '{{.Names}}' 2>/dev/null | while read -r n; do
      [ -z "$n" ] && continue
      docker inspect "$n" --format '{{.State.FinishedAt}}' 2>/dev/null
    done | grep -v '^0001-01-01' | cut -c1-19 | sort | uniq -c | sort -rn | awk '$1 >= 2')

  if [ -n "$CLUSTER" ]; then
    echo "$CLUSTER" | awk '{ printf "    %s 个容器停于 %s\n", $1, $2 }'
    echo
    echo "  ✗ 确实存在「多个容器在同一秒被停止」。这不是单容器问题 ——"
    echo "    只能是宿主级事件或一条批量命令（见第 4、6、7 节）。"
    VERDICT+=("多个容器的停止时间落在同一秒 → **确认是成批停止**。查 daemon 重启 / 宿主机重启 / 批量 stop 命令 / 面板自动部署")
  else
    echo "    （无。各容器的停止时间彼此分散 —— 「其它容器也一起停」这个前提可能不成立，"
    echo "      请回头按**单容器**原因排查：内存、崩溃、健康检查、端口冲突）"
    VERDICT+=("未发现成批停止的时间证据 → 请重新确认「其它容器也一起停」是否属实；若属实，请把各容器的停于时间发出来")
  fi

  echo
  echo "  最近 24 小时内，本容器的「启动→停止」循环（周期规律 = 有东西在定期动它）："
  CYCLES=$(docker events --since 24h --until 0s --filter "container=$CONTAINER" \
      --filter 'event=start' --filter 'event=die' \
      --format '{{.Time}} {{.Action}}' 2>/dev/null | tail -20 || true)
  if [ -z "$CYCLES" ]; then
    echo "    （无事件；daemon 重启会清空缓冲，换 SINCE='7d' 再试）"
  else
    echo "$CYCLES" | sed 's/^/    /'
    N_START=$(echo "$CYCLES" | grep -c ' start' || true)
    echo "    → 24 小时内启动 $N_START 次。若远大于 1 且间隔均匀，就是**定时任务**在动它。"
    if [ "${N_START:-0}" -ge 3 ] 2>/dev/null; then
      VERDICT+=("24 小时内本容器被启动了 $N_START 次 → 存在周期性重启，重点查定时任务 / 面板自动部署 / watchtower")
    fi
  fi
fi

# ---------------------------------------------------------------
title "3. 内核 OOM 记录"
# 容器 cgroup 超限被杀时，内核**不一定**在 dmesg 里留记录（cgroup 内的 OOM 常常是静默的），
# 所以「这里没有记录」不能排除 OOM —— 要以第 1 节的 OOMKilled 为准。
FOUND_OOM=0
if command -v dmesg >/dev/null 2>&1; then
  DM=$(dmesg -T 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process' | tail -20 || true)
  if [ -n "$DM" ]; then
    echo "  dmesg 中的 OOM 记录："
    echo "$DM" | sed 's/^/    /'
    FOUND_OOM=1
    VERDICT+=("内核日志里有 OOM 记录：整机内存曾耗尽，OOM killer 会挑进程杀，可能一次杀多个容器")
  else
    echo "  dmesg：无 OOM 记录（注意：容器 cgroup 内被杀时常常不写 dmesg，不能据此排除 OOM）"
  fi
else
  echo "  dmesg 不可用（部分精简系统/容器内没有该命令）"
fi
if command -v journalctl >/dev/null 2>&1; then
  JC=$(journalctl -k --since "$SINCE" 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process' | tail -20 || true)
  if [ -n "$JC" ]; then
    echo "  journalctl -k 中的 OOM 记录："
    echo "$JC" | sed 's/^/    /'
    FOUND_OOM=1
  fi
fi
[ "$FOUND_OOM" -eq 0 ] && echo "  → 未发现整机级 OOM 证据（若第 1 节 OOMKilled=true，那仍是容器自身超限）"

# ---------------------------------------------------------------
title "4. docker daemon 与宿主机有没有重启过"
# daemon 重启会**给所有容器发 SIGTERM**，再拉起时按 restart 策略恢复。
# 「启动后不久就停止」+「其它容器也停」与这个场景完全吻合。
if command -v systemctl >/dev/null 2>&1; then
  echo "  docker.service 最近的状态："
  systemctl status docker --no-pager 2>/dev/null | head -8 | sed 's/^/    /' || echo "    （读取失败）"
  echo
  echo "  docker.service 最近的启停记录："
  systemctl show docker -p ActiveEnterTimestamp -p NRestarts 2>/dev/null | sed 's/^/    /' || true
fi
if command -v journalctl >/dev/null 2>&1; then
  JD=$(journalctl -u docker --since "$SINCE" --no-pager 2>/dev/null \
        | grep -iE 'Stopping Docker|Starting Docker|Stopped Docker|Started Docker|Shutting down|daemon.*shutdown' | tail -20 || true)
  if [ -n "$JD" ]; then
    echo
    echo "  journalctl -u docker 里的启停记录："
    echo "$JD" | sed 's/^/    /'
    VERDICT+=("docker daemon 在故障时间窗内有启停记录 → daemon 重启会向所有容器发 SIGTERM。查它为什么重启（见下方 journalctl 全文）")
  else
    echo "  journalctl -u docker：该时间窗内无启停记录"
    echo "    （想深挖就执行：journalctl -u docker --since '$SINCE' --no-pager | tail -100）"
  fi
fi

echo
echo "  live-restore（daemon 重启时保留容器运行，默认关闭）："
LR=$(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null || echo '?')
echo "    LiveRestoreEnabled = $LR"
if [ "$LR" = "false" ]; then
  echo "    → 关闭状态下，**重启 docker daemon 会连带停止所有容器**。"
  echo "      若确认是 daemon 重启导致的，可在 /etc/docker/daemon.json 里开启："
  echo '        { "live-restore": true }'
  echo "      然后 systemctl reload docker（reload 不会停容器）。"
  echo "      注意：daemon.json 的修改会影响整台机器上的所有容器，请自行评估。"
fi

echo
echo "  宿主机是否重启过："
if command -v uptime >/dev/null 2>&1; then echo "    uptime    : $(uptime)"; fi
if command -v who >/dev/null 2>&1; then who -b 2>/dev/null | sed 's/^/    最近启动  : /'; fi
if command -v last >/dev/null 2>&1; then
  last -x reboot shutdown 2>/dev/null | head -8 | sed 's/^/    /'
fi
# /proc/uptime 只有 Linux 才有意义；在 macOS / Git Bash 上会给出误导性的小数值，
# 所以这里显式限定 Linux，避免在非 Linux 机器上抛出假的「刚重启过」结论。
UP_SEC=""
if [ "$(uname -s)" = "Linux" ] && [ -r /proc/uptime ]; then
  UP_SEC=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo '')
fi
if [ -n "$UP_SEC" ] && [ "$UP_SEC" -lt 86400 ] 2>/dev/null; then
  echo "    ⚠ 宿主机开机不到 24 小时 —— 机器本身刚重启过，这很可能就是原因。"
  VERDICT+=("宿主机 uptime 小于 24 小时 → 机器重启过。宿主机重启/关机/云厂商回收实例会一次性停掉所有容器")
fi

# ---------------------------------------------------------------
title "5. 磁盘空间（日志撑满分区会连带影响其它容器）"
df -h / 2>/dev/null | sed 's/^/  /'
echo
ROOT_USE=$(df -P / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
if [ -n "$ROOT_USE" ] && [ "$ROOT_USE" -ge 90 ] 2>/dev/null; then
  echo "  ✗ 根分区已用 ${ROOT_USE}% —— 空间严重不足。"
  echo "    磁盘写满时 Docker daemon 会无法写状态，**同机器的所有容器一起出问题**。"
  VERDICT+=("根分区使用率 ${ROOT_USE}%，磁盘即将写满 → 必须立即清理，并确认日志轮转已开启（第 1 节）")
else
  echo "  · 根分区使用率 ${ROOT_USE:-?}%"
fi

# Docker 的 data-root 不一定是 /var/lib/docker（很多 NAS / 面板会改到数据盘）
DOCKER_ROOT="/var/lib/docker"
if [ "$DOCKER_OK" -eq 1 ]; then
  DR=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo '')
  [ -n "$DR" ] && DOCKER_ROOT="$DR"
fi
echo "  Docker data-root = $DOCKER_ROOT"
if [ -d "$DOCKER_ROOT" ]; then
  DR_FS=$(df -h "$DOCKER_ROOT" 2>/dev/null | awk 'NR==2 {print $5}')
  echo "  该分区使用率     = ${DR_FS:-?}（这才是真正会被日志撑满的分区）"
  if [ -n "$DR_FS" ]; then
    DR_PCT=$(echo "$DR_FS" | tr -d '%')
    if [ "$DR_PCT" -ge 90 ] 2>/dev/null; then
      VERDICT+=("Docker data-root 所在分区已用 ${DR_FS} → 磁盘写满会让整机容器一起出问题")
    fi
  fi
  echo
  echo "  Docker 数据目录占用 Top 5："
  du -sh "$DOCKER_ROOT"/* 2>/dev/null | sort -rh | head -5 | sed 's/^/    /' \
    || echo "    （需要 root 权限）"
else
  echo "  （该目录不存在，可能用了别的 data-root）"
fi

if [ "$DOCKER_OK" -eq 1 ]; then
  echo
  echo "  各容器日志文件实际大小 Top 5："
  if [ -d "$DOCKER_ROOT/containers" ]; then
    du -sh "$DOCKER_ROOT"/containers/*/*.log 2>/dev/null | sort -rh | head -5 | sed 's/^/    /' \
      || echo "    （需要 root 权限：sudo du -sh $DOCKER_ROOT/containers/*/*.log | sort -rh | head）"
  fi
  echo
  echo "  docker 自身占用："
  docker system df 2>/dev/null | sed 's/^/    /' || true
fi

# ---------------------------------------------------------------
title "6. 「其它容器也停了」—— 确认停的是不是一整批"
if [ "$DOCKER_OK" -eq 0 ]; then
  echo "  （跳过：docker 不可用）"
else
  echo "  当前所有容器："
  docker ps -a --format '    {{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null | head -30 || true

  PROJ=$(compose_project)
  if [ -n "$PROJ" ]; then
    echo
    echo "  同一个 compose 项目（$PROJ）下的容器："
    docker ps -a --filter "label=com.docker.compose.project=$PROJ" \
      --format '    {{.Names}}\t{{.Status}}' 2>/dev/null | head -20 || true
    echo
    echo "    → 同一项目的容器是**一起被管理的**：任何一次"
    echo "      docker compose down / up -d / restart，都会给它们全体发 SIGTERM。"
    echo "      如果你用了 NAS 面板、1Panel、宝塔、Portainer 之类工具来管这套 compose，"
    echo "      它们定期「重新部署」就会造成这个现象。"
    echo "      → 处置：把本服务改成 docker run 单独跑，或关掉面板的自动重新部署。"
    VERDICT+=("容器属于 compose 项目 '$PROJ'：compose down/up -d/restart 会成批停容器。若「其它容器」就是同项目的服务，优先排查面板/定时任务的自动重新部署")
  else
    echo
    echo "  容器不属于任何 compose 项目（或标签读取失败）。"
    echo "  若「其它容器」与它无关却同时停止 → 基本锁定宿主机级事件（第 2、4 节）。"
  fi

  echo
  echo "  各容器的重启策略（没有重启策略的容器一旦被停就不会自己起来）："
  docker ps -a --format '{{.Names}}' 2>/dev/null | while read -r n; do
    [ -z "$n" ] && continue
    pol=$(docker inspect "$n" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || echo '?')
    printf '    %-24s %s\n' "$n" "${pol:-none}"
  done
fi

# ---------------------------------------------------------------
title "7. 有没有「第三方」在替你停容器"
echo "  —— 自动更新 / 面板类工具 ——"
for pat in watchtower portainer 1panel bt-panel dockge yacht; do
  if [ "$DOCKER_OK" -eq 1 ] && docker ps -a --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -qi "$pat"; then
    echo "  ⚠ 发现疑似工具：$(docker ps -a --format '{{.Names}} ({{.Image}})' | grep -i "$pat" | tr '\n' ' ')"
    VERDICT+=("检测到 '$pat'：这类工具会自动更新/重启容器，可能就是你看到的「批量停止」来源")
  fi
done
docker ps -a --format '  {{.Names}}  {{.Image}}' 2>/dev/null | head -20 || true

echo
echo "  —— 宿主机上正在运行的 compose / 部署脚本 ——"
# `docker compose up`（**不带 -d**）是前台运行：它 Ctrl+C、终端断开、或所在 SSH
# 会话被回收时，会向**它启动的那些容器**发 SIGTERM。
# 如果宿主机上挂着一个陈旧的 compose 进程（常见于 tmux/screen 里忘了退），
# 就能解释「启动后不久就停」。
PSOUT=$(ps -eo pid,ppid,etime,args 2>/dev/null | grep -E '[d]ocker[ -]compose|[d]ocker-compose' || true)
if [ -n "$PSOUT" ]; then
  echo "$PSOUT" | sed 's/^/    /'
  echo
  echo "    ⚠ 有 compose 进程正在运行。核对它的启动时间（etime）是否早于容器："
  echo "      若是，它退出时会顺手停掉容器 —— 改用 'docker compose up -d' 重新部署可避免。"
  VERDICT+=("宿主机上存在正在运行的 compose 进程：若是**前台**（不带 -d）运行，它退出/终端断开时会向容器发 SIGTERM")
else
  echo "    （没有）"
fi
if command -v tmux >/dev/null 2>&1; then
  T=$(tmux ls 2>/dev/null || true)
  [ -n "$T" ] && { echo "    存在 tmux 会话（可能挂着陈旧的部署命令）："; echo "$T" | sed 's/^/      /'; }
fi

echo
echo "  —— 定时任务 ——"
if command -v crontab >/dev/null 2>&1; then
  CRON=$(crontab -l 2>/dev/null | grep -vE '^\s*#' | grep -vE '^\s*$' || true)
  if [ -n "$CRON" ]; then echo "$CRON" | sed 's/^/    /'; else echo "    当前用户 crontab：空"; fi
fi
if [ -d /etc/cron.d ]; then
  CD=$(grep -rhiE 'docker|compose' /etc/cron.d /etc/crontab 2>/dev/null | grep -vE '^\s*#' || true)
  [ -n "$CD" ] && { echo "    /etc/cron.d 里与 docker 相关的条目："; echo "$CD" | sed 's/^/      /'; }
fi
if command -v systemctl >/dev/null 2>&1; then
  TIMERS=$(systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'docker|compose|watchtower' || true)
  [ -n "$TIMERS" ] && { echo "    与 docker 相关的 systemd timer："; echo "$TIMERS" | sed 's/^/      /'; }
fi
echo "    （systemd 系统级定时任务：systemctl list-timers --all）"

echo
echo "  —— systemd-oomd（会按 cgroup 杀进程，Ubuntu 22.04+ 默认开启）——"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active systemd-oomd >/dev/null 2>&1; then
  echo "    systemd-oomd 处于 active 状态。它会直接 SIGKILL 整个 cgroup，"
  echo "    表现同样是「容器凭空消失、没有任何日志」。"
  journalctl -u systemd-oomd --since "$SINCE" --no-pager 2>/dev/null | tail -10 | sed 's/^/      /' || true
  VERDICT+=("systemd-oomd 在运行：它会直接 SIGKILL 整个 cgroup，且不写应用日志。可用 journalctl -u systemd-oomd 查它是否杀过东西")
else
  echo "    systemd-oomd 未运行（或系统没有 systemd）"
fi

echo
echo "  —— 云厂商层面 ——"
echo "    如果这是云服务器（腾讯云轻量 / 阿里云 / AWS…），以下情况会直接关机，"
echo "    关机前内核会给所有进程发 SIGTERM："
echo "      · 欠费 / 到期 / 按量付费余额不足"
echo "      · 套餐流量跑超（轻量应用服务器常见）"
echo "      · 抢占式 / Spot 实例被回收"
echo "      · 安全事件被平台隔离"
echo "    请在云控制台的「操作日志 / 事件中心 / 告警」里核对故障时间点。"

# ---------------------------------------------------------------
title "诊断结论"
if [ ${#VERDICT[@]} -eq 0 ]; then
  echo "  本脚本没有找到明确的外部原因。"
  echo "  请把上面的完整输出，连同下面两条命令的结果一起留存："
  echo "    docker inspect $CONTAINER --format '{{.State}}'"
  echo "    journalctl -u docker --since '7d' --no-pager | tail -200"
else
  i=1
  for v in "${VERDICT[@]}"; do
    echo "  $i) $v"
    i=$((i+1))
  done
fi
hr
echo "提醒：日志里出现「收到 SIGTERM，开始优雅关闭…」+「✓ 已退出」是**正常关闭**，"
echo "      说明应用没有 bug。上面所有排查都围绕「谁发的这个信号」展开。"
echo
echo "把输出贴到 issue 时，请先删掉其中可能包含的域名、IP、密码等信息。"
