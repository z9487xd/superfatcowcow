/* 極簡靜態伺服器 (零依賴) ── npm start 用
 * 也可以完全不用 server: 直接用瀏覽器開 index.html。
 */
var http = require('http');
var fs = require('fs');
var path = require('path');

var PORT = process.env.PORT || 5173;
var ROOT = __dirname;
var TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

http.createServer(function (req, res) {
  var url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  var file = path.join(ROOT, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, function () {
  console.log('超肥牛牛 操作台: http://localhost:' + PORT);
  console.log('(投影視窗會自動用同一網址開第二個分頁/視窗)');
});
