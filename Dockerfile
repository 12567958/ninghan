# B 站解析中转 · 容器镜像
# 适用：apply.build / Koyeb / Zeabur / Render / Fly.io / Railway / 任意支持 Docker 的平台
#
# 部署要点（三家通用）：
#   - 容器端口：9000（代码里 PORT 环境变量控制，默认 9000）
#   - 环境变量：RELAY_TOKEN  = 一段随机字符串（强烈建议设，否则会被白嫖）
#   - 部署完拿到地址，填进 Cloudflare Worker 的 RELAY_BASE / RELAY_TOKEN

FROM node:20-alpine

# 只用一个小镜像就够了，中转本身零依赖
WORKDIR /app
COPY relay.mjs ./

# 有些平台强制要求非 root
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV PORT=9000
EXPOSE 9000

# 健康检查：GET / 会返回一个 JSON
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "relay.mjs"]
