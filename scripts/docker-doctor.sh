#!/usr/bin/env bash
# ============================================================
# docker-wxchat 启动故障诊断
#
# 用法：在项目根目录（有 docker-compose.yml 的地方）执行
#   bash scripts/docker-doctor.sh
#
# 目的：一次性回答「容器里到底在跑哪个镜像、cwd 是什么、CMD 是什么」，
#       从而区分 Cannot find module '/xxx' 的两种成因：
#         A. cwd 不是 /app，相对入口被解析到别处
#         B. CMD 里写死了绝对路径
# ============================================================

set -uo pipefail

SERVICE="wxchat"
CONTAINER="wxchat"
CANDIDATE_IMAGES=("docker-wxchat:latest" "wxchat-wxchat:latest" "wxchat:latest")

hr() { printf '%s\n' "------------------------------------------------------------"; }
title() { echo; echo "== $1 =="; }

VERDICT=()

# ---------------------------------------------------------------
title "0. 环境"
DOCKER_OK=1
if command -v docker >/dev/null 2>&1; then
  echo "docker      : $(docker --version 2>/dev/null || echo '命令存在但无法执行')"
  echo "compose     : $(docker compose version 2>/dev/null || echo '不可用')"
  docker info >/dev/null 2>&1 || { echo "  ⚠ docker 命令存在，但连不上 daemon"; DOCKER_OK=0; }
else
  echo "docker      : 不可用（当前环境没有安装 docker 或不在 PATH 中）"
  DOCKER_OK=0
fi
echo "当前目录    : $(pwd)"
if [ "$DOCKER_OK" -eq 0 ]; then
  echo
  echo "本脚本需要能访问 docker daemon。请在运行容器的宿主机上执行。"
  echo "（如果你只是想在本地核对文件，第 1、5 节仍然有效。）"
fi

# ---------------------------------------------------------------
title "1. 仓库里到底有几份 compose / Dockerfile"
FOUND=$(ls -1 docker-compose*.yml docker-compose*.yaml 2>/dev/null || true)
if [ -z "$FOUND" ]; then
  echo "  ✗ 没找到 compose 文件，请确认你在项目根目录"
else
  echo "$FOUND" | while read -r f; do echo "  $f"; done
  COUNT=$(echo "$FOUND" | wc -l | tr -d ' ')
  if [ "$COUNT" -gt 1 ]; then
    echo "  ⚠ 存在多份 compose 文件，docker-compose.override.yml 会被自动合并！"
    VERDICT+=("存在 $COUNT 份 compose 文件，可能有 override 在覆盖配置")
  fi
fi

# ---------------------------------------------------------------
title "2. 合并后真正生效的配置（不是文件原文）"
if [ "$DOCKER_OK" -eq 0 ]; then
  echo "  （跳过：docker 不可用）"
elif docker compose config >/tmp/.wxchat-cfg 2>/tmp/.wxchat-cfg-err; then
  grep -nE 'image:|command:|entrypoint:|working_dir:|pull_policy:|context:|dockerfile:|^\s+- /app' /tmp/.wxchat-cfg \
    || echo "  （未匹配到关键字段）"
  if grep -qE '^\s*command:' /tmp/.wxchat-cfg; then
    echo "  ⚠ compose 里有 command 覆盖，镜像自带的 CMD 被替换了"
    VERDICT+=("compose 中存在 command 覆盖")
  fi
  if grep -qE 'working_dir:' /tmp/.wxchat-cfg; then
    WD=$(grep -E 'working_dir:' /tmp/.wxchat-cfg | head -1 | sed 's/.*working_dir: *//')
    echo "  → working_dir = $WD"
    [ "$WD" != "/app" ] && VERDICT+=("working_dir 不是 /app，而是 $WD")
  else
    echo "  → 没有 working_dir，运行时 cwd 完全取决于镜像元数据"
  fi
  if ! grep -qE 'pull_policy:' /tmp/.wxchat-cfg; then
    echo "  ⚠ 没有 pull_policy：docker compose up 可能先 pull 同名镜像，而不是构建你的源码"
    VERDICT+=("缺少 pull_policy: build，存在跑错镜像的风险")
  else
    echo "  ✓ 已设置 pull_policy"
  fi
else
  echo "  ✗ docker compose config 失败："
  sed 's/^/    /' /tmp/.wxchat-cfg-err
  VERDICT+=("compose 配置本身无法解析")
fi

# ---------------------------------------------------------------
title "3. 本地镜像里的 WORKDIR 与 CMD"
FOUND_IMAGE=""
if [ "$DOCKER_OK" -eq 0 ]; then
  echo "  （跳过：docker 不可用）"
else
for img in "${CANDIDATE_IMAGES[@]}"; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    FOUND_IMAGE="$img"
    echo "  镜像: $img"
    docker image inspect "$img" \
      --format '    WorkingDir = {{.Config.WorkingDir}}
    Cmd        = {{json .Config.Cmd}}
    Entrypoint = {{json .Config.Entrypoint}}
    Created    = {{.Created}}'
    WD=$(docker image inspect "$img" --format '{{.Config.WorkingDir}}')
    CMDJ=$(docker image inspect "$img" --format '{{json .Config.Cmd}}')
    if [ "$WD" != "/app" ]; then
      VERDICT+=("镜像 $img 的 WorkingDir 是 '$WD'，不是 /app → 这就是 cwd 错误的原因")
    fi
    case "$CMDJ" in
      *'"/src/server.js"'*|*'"/server.js"'*|*'"/app/src/server.js"'*)
        VERDICT+=("镜像 $img 的 CMD 用了绝对路径 $CMDJ → 必须改成相对路径") ;;
    esac
    echo "    ✓ 字段已读取"
  fi
done
[ -z "$FOUND_IMAGE" ] && echo "  （本地没有找到候选镜像，可能还没构建）"
fi

# ---------------------------------------------------------------
title "4. 正在运行的容器"
if [ "$DOCKER_OK" -eq 0 ]; then
  echo "  （跳过：docker 不可用）"
elif docker inspect "$CONTAINER" >/dev/null 2>&1; then
  docker inspect "$CONTAINER" --format '  容器 WorkingDir = {{.Config.WorkingDir}}
  Cmd              = {{json .Config.Cmd}}
  Entrypoint       = {{json .Config.Entrypoint}}
  Image            = {{.Config.Image}}
  ImageID          = {{.Image}}
  状态             = {{.State.Status}}  退出码={{.State.ExitCode}}
  启动时间         = {{.State.StartedAt}}'
  echo "  最近日志:"
  docker logs --tail=15 "$CONTAINER" 2>&1 | sed 's/^/    /'

  echo
  echo "  容器内实际 cwd:"
  if docker compose exec -T "$SERVICE" node -e "console.log(process.cwd())" 2>/dev/null; then
    REALCWD=$(docker compose exec -T "$SERVICE" node -e "process.stdout.write(process.cwd())" 2>/dev/null)
    if [ -n "$REALCWD" ] && [ "$REALCWD" != "/app" ]; then
      VERDICT+=("容器内 cwd 实际是 '$REALCWD'，不是 /app")
    elif [ "$REALCWD" = "/app" ]; then
      echo "    ✓ cwd 是 /app"
    fi
  else
    echo "    ✗ 无法在容器内执行命令（容器可能已经退出）"
    VERDICT+=("容器无法执行命令，很可能已崩溃退出")
  fi
else
  echo "  容器 '$CONTAINER' 不存在（还没起过，或者用了别的 container_name）"
fi

# ---------------------------------------------------------------
title "5. Dockerfile 换行符"
if [ -f Dockerfile ]; then
  # 用 tr 统计 CR 字节数，比 grep $'\r' 可靠（后者在部分 Git Bash 上会误匹配每一行）
  CR=$(tr -cd '\r' < Dockerfile | wc -c | tr -d ' ')
  if [ "$CR" -gt 0 ]; then
    echo "  ✗ Dockerfile 含 $CR 个 CR 字符（CRLF 换行），WORKDIR 可能带上不可见的 \\r"
    VERDICT+=("Dockerfile 是 CRLF 换行，建议转成 LF")
  else
    echo "  ✓ Dockerfile 是 LF 换行"
  fi
  echo "  入口相关指令:"
  grep -nE '^(FROM|WORKDIR|USER|EXPOSE|CMD|ENTRYPOINT)' Dockerfile | sed 's/^/    /'
fi

# ---------------------------------------------------------------
title "6. 宿主机数据目录的属主（容器 EACCES 的头号原因）"
# 容器内进程以 PUID:PGID（默认 1000:1000）运行，宿主机目录属主必须能对上，
# 否则启动时会报「数据目录不可写 / 上传目录不可写」或 SQLite 的 CANTOPEN。
HOST_PUID=$(grep -E '^[[:space:]]*PUID[[:space:]]*=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r"' || true)
HOST_PGID=$(grep -E '^[[:space:]]*PGID[[:space:]]*=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r"' || true)
HOST_PUID=${HOST_PUID:-1000}
HOST_PGID=${HOST_PGID:-1000}
echo "  容器运行身份 (PUID:PGID) : ${HOST_PUID}:${HOST_PGID}"
echo
# 只有 Linux 宿主机才有 bind mount 属主问题；
# Windows/macOS 的 uid 是 SID 之类的占位值，比较没有意义，直接跳过。
if [ "$(uname -s)" != "Linux" ]; then
  echo "  （跳过属主比较：当前系统是 $(uname -s)，不是 Linux。"
  echo "    Windows / macOS 的 Docker Desktop 走文件共享层，不存在此问题。）"
else
for d in data uploads; do
  if [ ! -e "$d" ]; then
    echo "  ✗ $d 不存在 —— Docker 会以 root 自动创建，导致容器写不进去"
    VERDICT+=("$d 目录不存在，先执行 mkdir -p data uploads")
    continue
  fi
  if [ ! -d "$d" ]; then
    echo "  ✗ $d 是一个文件，不是目录 —— volume 映射有问题"
    VERDICT+=("$d 不是目录")
    continue
  fi
  OWNER_UID=$(stat -c '%u' "$d" 2>/dev/null || echo '?')
  OWNER_GID=$(stat -c '%g' "$d" 2>/dev/null || echo '?')
  MODE=$(stat -c '%a' "$d" 2>/dev/null || echo '?')
  printf '  %-8s 属主=%s:%s 权限=%s' "$d" "$OWNER_UID" "$OWNER_GID" "$MODE"
  if [ "$OWNER_UID" != "$HOST_PUID" ] && [ "$OWNER_UID" != "0" ]; then
    echo "   ⚠ 属主与 PUID 不一致"
  elif [ "$OWNER_UID" = "0" ] && [ "$HOST_PUID" != "0" ]; then
    echo "   ✗ 属主是 root，而容器以 ${HOST_PUID} 运行 → 会 EACCES"
    VERDICT+=("$d 属于 root，容器以 ${HOST_PUID} 运行写不进去。执行：sudo chown -R ${HOST_PUID}:${HOST_PGID} ./data ./uploads（或 bash scripts/fix-permissions.sh）")
  else
    echo "   ✓ 属主匹配"
  fi
  # 实际写一下，最直接的验证
  if (umask 022; : > "$d/.doctor-probe") 2>/dev/null; then
    rm -f "$d/.doctor-probe" 2>/dev/null || true
  else
    echo "        ✗ 当前用户也写不进去"
  fi
done
fi

# SELinux 检查
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  echo
  echo "  ⚠ SELinux 处于 Enforcing，bind mount 需要标签：- ./data:/app/data:Z"
  VERDICT+=("SELinux 为 Enforcing，volume 需要加 :Z 标签")
fi

# ---------------------------------------------------------------
title "诊断结论"
if [ ${#VERDICT[@]} -eq 0 ]; then
  echo "  未发现明显问题。如果容器仍然启动失败，请把上面第 2、3、4 节的输出发出来。"
else
  i=1
  for v in "${VERDICT[@]}"; do
    echo "  $i) $v"
    i=$((i+1))
  done
  echo
  echo "  推荐处置："
  echo "    docker compose down --rmi local --volumes"
  echo "    docker compose up -d --build"
  echo "    docker compose exec $SERVICE node -e \"console.log(process.cwd())\"   # 应为 /app"
fi
hr
echo "提示：若第 2 节显示 command/working_dir 被覆盖，请检查 docker-compose.override.yml"
echo "      以及 NAS/面板类工具（群晖、Portainer、1Panel）里手工填写的「工作目录」「命令」字段。"
