# ============================================================
# docker-wxchat —— 微信文件传输助手 · 自托管发行版
# ------------------------------------------------------------
# 关于历史上的 "Cannot find module '/server.js'" 报错，本文件从三个层面根除：
#
#   1. WORKDIR 固定为 /app。Node 解析相对入口时基于 cwd，绝不会再去文件系统
#      根目录找 /server.js。
#   2. CMD 使用相对路径 ["node", "src/server.js"]，并且 src/server.js 确实
#      被 COPY 进镜像（见下方 COPY 指令）。绝对路径入口一律禁止。
#   3. 启动时 src/server.js 会打印 cwd 与入口绝对路径，并断言
#      ${cwd}/package.json 可读，工作目录不对会立刻报错退出，而不是运行中才炸。
# ============================================================

FROM node:20-alpine

# better-sqlite3 在没有匹配预编译包时需要用源码编译，因此安装工具链。
#
# 注意 libstdc++：它必须作为「正式包」单独安装，而不是只作为 g++ 的依赖。
# 否则 `apk del .build-deps` 会把不再被引用的 libstdc++ 一起删掉，
# 镜像能构建成功，但运行时加载 better-sqlite3 会报：
#   Error loading shared library libstdc++.so.6: No such file or directory
RUN apk add --no-cache libstdc++ \
 && apk add --no-cache --virtual .build-deps python3 make g++

WORKDIR /app

# 先只复制依赖清单，让依赖层可以被 Docker 缓存复用
COPY package.json package-lock.json ./

# 生产依赖；编译完删掉临时工具链，缩小镜像体积
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && apk del .build-deps

# 再复制源码。注意 src/ 必须包含 src/server.js（CMD 的相对入口）
COPY src ./src
COPY public ./public
COPY database ./database
COPY scripts ./scripts
COPY LICENSE ./LICENSE

# 构建期断言：入口文件必须真的在镜像里。
#
# 这一层把「COPY 漏项 / 路径写错 / .dockerignore 误伤」在构建阶段就拦下来。
# 否则镜像能构建成功，直到容器启动才报 Cannot find module，
# 而且报错发生在 Node 内部，排查成本高得多。
RUN set -e; \
    for f in /app/src/server.js /app/package.json /app/database/schema.sql /app/public/index.html; do \
      if [ ! -f "$f" ]; then \
        echo "构建失败：镜像内缺少 $f" >&2; \
        exit 1; \
      fi; \
    done; \
    echo "✓ 入口文件校验通过"

# 构建期断言 2：前端资源清单必须完整。
#
# 上面的断言只看 4 个入口文件 —— 只要 index.html 在，就算 public/ 只被复制了一部分，
# 构建也会成功，直到用户打开页面才发现样式/脚本 404。
# public/sw.js 的 PRECACHE 恰好是一份现成的「前端必须存在的资源清单」，
# 用它做全量存在性校验，等于免费获得一次「COPY 漏项 / .dockerignore 误伤」的兜底。
#
# 校验逻辑放在独立脚本里而不是写成内联 node -e：
# 避免在 Dockerfile 里嵌套 shell + JS 两层转义，那种写法极易因引号问题构建失败。
RUN node scripts/verify-precache.js

# 数据目录：镜像内先建好并授权给 node 用户。
# 首次使用命名卷时 Docker 会继承这里的属主，避免权限问题。
RUN mkdir -p /app/data /app/uploads \
 && chown -R node:node /app

# 非 root 运行
USER node

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/wxchat.db \
    UPLOAD_PATH=/app/uploads

# ------------------------------------------------------------
# 入口：必须同时满足两个条件，缺一不可
#
#   1. WORKDIR 为 /app（上面第 25 行）—— 它决定 cwd
#   2. CMD 用相对路径 "src/server.js" —— Node 基于 cwd 解析成 /app/src/server.js
#
# 绝对路径入口（如 node /server.js、node /src/server.js）一律禁止：
# 那种写法会绕过 cwd，直接去文件系统根目录找，一旦镜像里 WORKDIR 丢失
# 就会以「Cannot find module '/xxx'」的形式炸掉，而且和真实原因毫无关联。
#
# 想确认镜像里到底存了什么，可以随时查看：
#   docker image inspect <镜像名> --format 'WorkingDir={{.Config.WorkingDir}} Cmd={{json .Config.Cmd}}'
# ------------------------------------------------------------
CMD ["node", "src/server.js"]

