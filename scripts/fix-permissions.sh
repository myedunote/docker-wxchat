#!/usr/bin/env bash
# ============================================================
# 修正 ./data 与 ./uploads 的属主，让容器内的非 root 进程可写
#
# 用法：在项目根目录（有 docker-compose.yml / .yaml 的地方）执行
#   bash scripts/fix-permissions.sh
#
# 背景：
#   容器内进程默认以 uid/gid = PUID:PGID（默认 1000:1000，即镜像里的 node 用户）运行。
#   如果宿主机上的 ./data 属于 root（例如你曾在 root 身份下执行过 docker compose，
#   Docker 会自动以 root 创建缺失的挂载目录），容器就会启动失败：
#     [wxchat] ✗ 数据目录不可写：/app/data
#     EACCES: permission denied, open '/app/data/.write-probe'
#   本脚本把这两个目录交给 PUID:PGID，并顺带检查 SELinux 标签。
# ============================================================

set -uo pipefail

# ---- 读取 .env 里的 PUID/PGID（默认 1000）----
PUID_V=1000
PGID_V=1000
if [ -f .env ]; then
  # tr -d ' \r"' 去掉空格、回车与成对引号（tr 会解释 \r）
  v=$(grep -E '^[[:space:]]*PUID[[:space:]]*=' .env | tail -1 | cut -d= -f2- | tr -d ' \r"' || true)
  [ -n "${v:-}" ] && PUID_V="$v"
  v=$(grep -E '^[[:space:]]*PGID[[:space:]]*=' .env | tail -1 | cut -d= -f2- | tr -d ' \r"' || true)
  [ -n "${v:-}" ] && PGID_V="$v"
fi

DIRS=(data uploads)

echo "============================================================"
echo "docker-wxchat 目录权限修正"
echo "------------------------------------------------------------"
echo "当前用户     : $(id -un) (uid=$(id -u))"
echo "目标属主     : ${PUID_V}:${PGID_V}"
echo "处理目录     : ${DIRS[*]}"
echo "============================================================"

# 只有 Linux 宿主机才有 bind mount 属主问题。
# Windows / macOS 的 Docker Desktop 走文件共享层映射，chown 是空操作，
# 继续跑会给出「已修好」的假象，所以这里直接说明并退出。
if [ "$(uname -s)" != "Linux" ]; then
  echo
  echo "当前系统是 $(uname -s)，不是 Linux。"
  echo "Windows / macOS 的 Docker Desktop 通过文件共享层映射权限，"
  echo "一般不会遇到「目录属主不对」的问题，无需执行本脚本。"
  echo
  echo "如果你确实在容器里看到 EACCES，请优先检查："
  echo "  · Docker Desktop 的「文件共享」设置里是否包含了本项目所在磁盘"
  echo "  · 是否把项目放在了需要额外授权的目录（如某些系统目录）"
  exit 0
fi

echo

# ---- 1. 确保目录存在 ----
for d in "${DIRS[@]}"; do
  if [ ! -d "$d" ]; then
    echo "  · $d 不存在，创建"
    mkdir -p "$d" 2>/dev/null || sudo mkdir -p "$d"
  fi
done

# ---- 2. 判断是否需要 sudo ----
# 直接用「能不能改属主」来判断，比猜更可靠
NEED_SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  # 非 root：先试着 chown，失败再上 sudo
  if ! chown "${PUID_V}:${PGID_V}" "data" 2>/dev/null; then
    NEED_SUDO="sudo"
  fi
fi

echo
echo "→ 修正属主${NEED_SUDO:+（需要 sudo，可能提示输入密码）}"
if ! ${NEED_SUDO} chown -R "${PUID_V}:${PGID_V}" "${DIRS[@]}"; then
  echo
  echo "✗ chown 失败。请检查目录是否被占用，或改用命名卷方案（见 README）。"
  exit 1
fi
echo "  ✓ 属主已设为 ${PUID_V}:${PGID_V}"

# ---- 3. 验证：以目标身份实际写一个探针文件 ----
echo
echo "→ 验证可写性"
FAIL=0
for d in "${DIRS[@]}"; do
  probe="$d/.perm-check"
  if (umask 022; : > "$probe") 2>/dev/null; then
    echo "  ✓ $d 可写"
    rm -f "$probe"
  else
    echo "  ✗ $d 仍不可写"
    FAIL=1
  fi
done

# ---- 4. SELinux 检查 ----
echo
echo "→ SELinux 检查"
if command -v getenforce >/dev/null 2>&1; then
  MODE=$(getenforce 2>/dev/null || echo Unknown)
  echo "  当前模式: $MODE"
  if [ "$MODE" = "Enforcing" ]; then
    echo
    echo "  ⚠ SELinux 处于 Enforcing，bind mount 很可能被拦截（即使属主正确）。"
    echo "    请把 compose 里的挂载改成带标签的形式："
    echo "      - ./data:/app/data:Z"
    echo "      - ./uploads:/app/uploads:Z"
    echo "    然后 docker compose up -d"
  fi
else
  echo "  未安装 SELinux（无需处理）"
fi

# ---- 5. 当前状态 ----
echo
echo "→ 目录当前状态"
for d in "${DIRS[@]}"; do
  ls -ld "$d" 2>/dev/null | awk '{printf "  %s  属主=%s:%s  权限=%s\n", $NF, $3, $4, $1}'
done

echo
echo "============================================================"
if [ "$FAIL" -eq 0 ]; then
  echo "✓ 完成。现在执行："
  echo "    docker compose up -d --build"
  echo "  日志里应出现：[wxchat] ✓ 数据目录可写: /app/data"
else
  echo "✗ 仍有目录不可写，请把上面的输出发出来。"
  echo "  备选方案：改用命名卷（不会有属主问题），见 README 的「数据库 / 上传目录打不开」。"
  exit 1
fi
echo "============================================================"
