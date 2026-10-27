#!/usr/bin/env bash
# ============================================================
# pixel-sandbox 联机服务端 · PM2 一键启动脚本（Linux / 宝塔面板）
# 用法：  bash start.sh
# 依赖：  Node.js 16+ 与 pm2（宝塔【软件商店】装 Node 版本管理器 + npm i -g pm2）
# ============================================================
set -e

# 1) 定位到脚本所在目录，进入 server/（server.js 的 ROOT = 上级目录需含 index.html）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/server"
echo "📁 工作目录: $(pwd)"

# 2) 环境探测
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 node，请先在宝塔安装 Node.js 16+"
  exit 1
fi
if ! command -v pm2 >/dev/null 2>&1; then
  echo "❌ 未找到 pm2，请先执行: npm install -g pm2"
  exit 1
fi
echo "✅ node: $(node -v)   pm2: $(pm2 -v)"

# 3) 安装依赖（仅在 node_modules 不存在时拉包，避免重复 install）
if [ ! -d node_modules ]; then
  echo "📦 安装依赖 (npm install) ..."
  npm install
else
  echo "📦 node_modules 已存在，跳过 npm install"
fi

# 4) 启动 / 重载（同名进程存在则热重载，避免重复实例占端口）
if pm2 describe pixel-sandbox >/dev/null 2>&1; then
  echo "🔄 重载已有 pixel-sandbox 进程 ..."
  pm2 reload pixel-sandbox
else
  echo "🚀 首次启动 pixel-sandbox ..."
  # 生产环境建议去掉 --watch（文件变动会自动重启）；调试期保留更方便
  pm2 start server.js --name pixel-sandbox --watch
fi

# 5) 持久化进程列表（配合 pm2 startup 实现开机自启）
pm2 save

echo ""
echo "✅ 启动完成！"
echo "   直连访问 : http://<服务器IP>:8080"
echo "   查看日志 : pm2 logs pixel-sandbox"
echo "   查看状态 : pm2 status"
echo ""
echo "⚠️ 首次部署请手动执行一次开机自启（需 root 权限）："
echo "   pm2 startup"
echo "   pm2 save"
