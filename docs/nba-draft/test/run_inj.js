const { chromium } = require('playwright'); const path = require('path'); const http = require('http'), fs = require('fs');
(async () => {
  const root = path.resolve(process.argv[2]);
  const srv = http.createServer((q, r) => { const f = path.join(root, decodeURIComponent(q.url.split('?')[0] === '/' ? '/index.html' : q.url.split('?')[0])); fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; return r.end('nf'); } r.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.json') ? 'application/json' : 'text/html'); r.end(d); }); }).listen(8768);
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.on('pageerror', e => console.log('PAGEERROR', e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('CONSOLE', m.text()); });
  await page.route(/^https?:\/\/[^/]*(sleeper|espn|corsproxy|allorigins|codetabs|api\.github\.com|raw\.githubusercontent)/, route => route.abort('failed'));
  await page.goto('http://localhost:8768/');
  await page.waitForFunction(() => document.querySelector('#gainTable table, #gainTable p'), null, { timeout: 30000 }); await page.waitForTimeout(500);
  console.log('HEAD:', await page.textContent('#leagueName'), '|', await page.textContent('#repMeta'));
  console.log('GAIN:\n' + (await page.$eval('#gainTable', e => e.innerText)).slice(0, 1500));
  console.log('LOSE:\n' + (await page.$eval('#loseTable', e => e.innerText)).slice(0, 800));
  console.log('OUT:\n' + (await page.$eval('#outTable', e => e.innerText)).slice(0, 600));
  await page.screenshot({ path: 'inj.png', fullPage: true });
  const first = await page.$('#gainTable .name'); if (first) { await first.click(); await page.waitForTimeout(1200); console.log('MODAL:', (await page.textContent('#modalBody')).replace(/\s+/g, ' ').slice(0, 500)); }
  console.log('DIAG:\n' + await page.textContent('#diag'));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
