# 宝塔部署

将项目解压至 /www/wwwroot/pixel-sandbox，选择 Node.js 24+，启动文件 server/server.js，端口 8080，实例数 1。
设置 OP_PASSWORD 环境变量为自己的管理密码。node-config.json 是填写面板参数的参考，不是宝塔自动导入格式。
在站点 server 配置块加入 nginx.conf 中的 location 段，避免重复的 location /。
整个站点通过 Node 反向代理，不要把项目根目录直接作为可下载的静态目录，否则可能绕过 Node 的私有文件隔离。
使用 HTTPS 时由宝塔配置证书，浏览器使用同域 WebSocket。SakuraFrp 则将隧道目标指向 127.0.0.1:8080。
