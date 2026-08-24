# 云桥（Node 形态）：无状态密文信封路由。示例：
#   docker build -t cc-cloud-bridge ./cloud-bridge
#   docker run -d -p 8790:8790 -e CLOUD_TOKEN=<8位以上随机串> cc-cloud-bridge
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY tsconfig.json ./
COPY src ./src
EXPOSE 8790
CMD ["node_modules/.bin/tsx", "src/index.ts"]
