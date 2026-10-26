// Prueba de la página de lesiones con datos reales de data/ y red externa bloqueada.
// Uso: node run_inj.js <carpeta del sitio>   (env W=ancho, PORT=puerto)
const { chromium } = require('playwright'); const path = require('path'); const http = require('http'), fs = require('fs');
(async () => {
  const root = path.resolve(process.argv[2] || '..');
  const port = +(process.env.PORT || 8768), W = +(process.env.W || 1500);
  const srv = http.createServer((q, r) => { const f = path.join(root, decodeURIComponent(q.url.split('?')[0] === '/' ? '/index.html' : q.url.split('?')[0])); fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; return r.end('nf'); } r.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.json') ? 'application/json' : 'text/html'); r.end(d); }); }).listen(port);
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: W, height: 1100 } });
  let errors = 0;
  page.on('pageerror', e => { errors++; console.log('PAGEERROR', e.message); }); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('CONSOLE', m.text()); });
  await page.route(/^https?:\/\/[^/]*(sleeper|espn|corsproxy|allorigins|codetabs|api\.github\.com|raw\.githubusercontent)/, route => route.abort('failed'));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.querySelector('#gainList .icard, #gainList p'), null, { timeout: 30000 }); await page.waitForTimeout(500);
  console.log('HEAD:', await page.textContent('#leagueName'), '|', await page.textContent('#repMeta'));
  console.log('GAIN:\n' + (await page.$eval('#gainList', e => e.innerText)).slice(0, 800));
  console.log('LOSE:\n' + (await page.$eval('#loseList', e => e.innerText)).slice(0, 400));
  console.log('OUT:\n' + (await page.$eval('#outTable', e => e.innerText)).slice(0, 300));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('OVERFLOW_PX:', overflow);
  await page.screenshot({ path: W < 700 ? 'inj_m.png' : 'inj.png', fullPage: true });
  const first = await page.$('#gainList .name'); if (first) { await first.click(); await page.waitForTimeout(1200); console.log('MODAL:', (await page.textContent('#modalBody')).replace(/\s+/g, ' ').slice(0, 300)); }
  console.log('PAGE_ERRORS:', errors);
  await browser.close(); srv.close();
  process.exit(errors ? 1 : 0);
})();
