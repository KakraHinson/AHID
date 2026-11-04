const http = require('http');
const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const port = Number(process.env.PORT || 8000);

const HUBTEL_WEBHOOK_PATHS = new Set([
  '/webhooks/hubtel',
  '/hubtel/webhook',
  '/hubtel/callback',
  '/hubtel-webhook',
  '/api/hubtel/webhook',
  '/api/hubtel/callback',
  '/callbacks/hubtel',
]);

const HUBTEL_MAX_BODY_BYTES = 1024 * 1024;

function parseIncomingBody(rawBody, contentType) {
  if (!rawBody) return {};

  if (String(contentType || '').toLowerCase().includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }

  try {
    return JSON.parse(rawBody);
  } catch (_) {
    return { raw: rawBody };
  }
}

function handleHubtelWebhook(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes <= HUBTEL_MAX_BODY_BYTES) chunks.push(chunk);
      else tooLarge = true;
    });

    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      req.body = tooLarge
        ? { error: 'Hubtel callback payload exceeded the maximum accepted size.' }
        : parseIncomingBody(rawBody, req.headers['content-type']);

      console.log("--- INCOMING HUBTEL CALLBACK ---", JSON.stringify(req.body, null, 2));

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'success' }));
      resolve();
    });

    req.on('error', (error) => {
      req.body = { error: error.message || 'Unable to read Hubtel callback payload.' };
      console.log("--- INCOMING HUBTEL CALLBACK ---", JSON.stringify(req.body, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'success' }));
      resolve();
    });
  });
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const server = http.createServer((req, res) => {
  try {
    const requestUrl = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname === '/') {
      pathname = '/index.html';
    }

    if (req.method === 'POST' && HUBTEL_WEBHOOK_PATHS.has(pathname.toLowerCase())) {
      void handleHubtelWebhook(req, res);
      return;
    }

    if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/')) {
      pathname = '/admin.html';
    }

    if (pathname === '/store' || pathname === '/store/' || pathname === '/storefront') {
      pathname = '/storefront.html';
    }

    const storeRoute = pathname.match(/^\/store\/([a-z0-9-_]+)\/?$/i);
    if (storeRoute) {
      pathname = '/storefront.html';
      requestUrl.searchParams.set('slug', storeRoute[1].toLowerCase());
    }

    const safePath = path.normalize(path.join(rootDir, pathname));
    if (!safePath.startsWith(rootDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    fs.stat(safePath, (statErr, stats) => {
      if (statErr || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const extension = path.extname(safePath).toLowerCase();
      const contentType = mimeTypes[extension] || 'application/octet-stream';

      fs.readFile(safePath, (readErr, data) => {
        if (readErr) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Server error');
          return;
        }

        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        });
        res.end(data);
      });
    });
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Server error');
  }
});

server.listen(port, () => {
  console.log(`Local web server running at http://localhost:${port}`);
  console.log('Open http://localhost:8000/login.html or http://localhost:8000/admin in the browser');
});

server.on('error', (error) => {
  console.error('Failed to start server:', error.message);
  process.exit(1);
});
