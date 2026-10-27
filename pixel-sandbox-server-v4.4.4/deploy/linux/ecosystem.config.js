const path = require('path');
module.exports={apps:[{name:'pixel-sandbox',cwd:path.resolve(__dirname,'../..'),script:'server/server.js',instances:1,exec_mode:'fork',env:{NODE_ENV:'production',PORT:8080}}]};
