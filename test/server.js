// Serves web/ and exposes the real Code.gs (via mock) at POST /api — for local end-to-end tests.
const http = require('http'), fs = require('fs'), path = require('path'), {create} = require('./mock-gas');
const g = create(); g.props.OWNER_EMAIL = 'owner@test.com'; g.props.OWNER_PIN = '483921'; g.setup();
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json'};
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') { let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const out = g.callRaw ? g.callRaw(b) : null; let j; try { const o = JSON.parse(b); j = JSON.stringify(g.call(o.action, o)); } catch { j = '{"ok":false,"error":"bad"}'; }
    res.writeHead(200, {'Content-Type': 'application/json'}); res.end(j); }); return; }
  let f = path.join(__dirname, '../web', req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('nf'); } res.writeHead(200, {'Content-Type': types[path.extname(f)] || 'application/octet-stream'}); res.end(d); });
}).listen(8765, () => console.log('up'));
