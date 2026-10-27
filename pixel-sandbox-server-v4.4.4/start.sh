#!/usr/bin/env bash
# ============================================================
#  Pixel Sandbox 一键启动脚本 (Linux / macOS)
# ------------------------------------------------------------
#  用法:
#    ./start.sh            一键启动（依赖缺失自动安装，前台运行）
#    ./start.sh install    仅安装依赖 (npm install --omit=dev)
#    ./start.sh start      启动（默认；检测到 pm2 则用 pm2 托管）
#    ./start.sh stop       停止服务
#    ./start.sh restart    重启服务
#    ./start.sh status     查看运行状态
#    ./start.sh frp        查看 SakuraFrp 公网地址
#  生产部署可用 OP_PASSWORD / PORT 环境变量。
# ============================================================
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$APP_ROOT/server"
WS_MODULE="$SERVER_DIR/node_modules/ws"
PORT="${PORT:-8080}"

echo "========================================"
echo " Pixel Sandbox 启动工具 (V4.4.4)"
echo "========================================"

ensure_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] 未找到 Node.js，请先安装 Node.js (>=24)。"
    exit 1
  fi
}

install_deps() {
  ensure_node
  echo "[INFO] 安装依赖..."
  (cd "$SERVER_DIR" && npm install --omit=dev)
  echo "[OK] 依赖安装完成。"
}

start_server() {
  ensure_node
  if [ ! -d "$WS_MODULE" ]; then
    install_deps
  fi
  echo "[INFO] 监听地址: 0.0.0.0:${PORT}"
  echo "[INFO] 保持此终端打开 = 服务器运行中；Ctrl+C 停止。"
  if command -v pm2 >/dev/null 2>&1; then
    echo "[INFO] 检测到 pm2，使用 pm2 托管 (deploy/linux/ecosystem.config.js)。"
    pm2 start "$APP_ROOT/deploy/linux/ecosystem.config.js"
    return
  fi
  cd "$SERVER_DIR" && exec node server.js
}

stop_server() {
  if command -v pm2 >/dev/null 2>&1; then
    pm2 stop pixel-sandbox 2>/dev/null || true
  fi
  if pgrep -f '[s]erver\.js' >/dev/null 2>&1; then
    pkill -f '[s]erver\.js' && echo "[OK] 已停止服务。" || echo "[WARN] 停止失败，请手动结束 node 进程。"
  else
    echo "[INFO] 没有运行中的服务。"
  fi
}

status_server() {
  if pgrep -f '[s]erver\.js' >/dev/null 2>&1; then
    echo "[OK] 服务运行中。PID: $(pgrep -f '[s]erver\.js' | tr '\n' ' ')"
  else
    echo "[INFO] 服务未运行。"
  fi
}

frp_info() {
  ensure_node
  if [ ! -f "$SERVER_DIR/sakura-frp.js" ]; then
    echo "[ERROR] 找不到 $SERVER_DIR/sakura-frp.js"
    exit 1
  fi
  (cd "$SERVER_DIR" && node -e "const m=require('./sakura-frp'); console.log(JSON.stringify(m.getPublicAddressInfo(),null,2))")
}

CMD="${1:-start}"
case "$CMD" in
  install) install_deps ;;
  start)   start_server ;;
  stop)    stop_server ;;
  restart)
    if command -v pm2 >/dev/null 2>&1; then
      pm2 restart pixel-sandbox 2>/dev/null || pm2 start "$APP_ROOT/deploy/linux/ecosystem.config.js"
    else
      stop_server
      sleep 1
      start_server
    fi
    ;;
  status)  status_server ;;
  frp)     frp_info ;;
  *) echo "用法: $0 {start|stop|restart|status|install|frp}"; exit 1 ;;
esac
