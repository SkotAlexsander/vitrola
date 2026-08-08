/* Teste de fumaça da Vitrola 3.0 num navegador de verdade.
   Serve a pasta por HTTP (service worker e IndexedDB não gostam de file://),
   abre em viewport de celular, recolhe erro de console e de página, confere
   que os pedaços novos existem no DOM, e grava as capturas. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// path.resolve normaliza a barra: no Windows o path.join devolve "\" e a
// comparacao com um caminho escrito com "/" falhava, 404 em tudo.
const RAIZ = path.resolve(process.argv[2]);
const SAIDA = path.resolve(process.argv[3] || RAIZ);

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

const servidor = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const arq = path.join(RAIZ, p);
  if (!arq.startsWith(RAIZ) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) {
    res.writeHead(404); res.end('nao achei'); return;
  }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq)] || 'application/octet-stream' });
  res.end(fs.readFileSync(arq));
});

(async () => {
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  const porta = servidor.address().port;
  const base = `http://127.0.0.1:${porta}/`;

  const navegador = await chromium.launch();
  const contexto = await navegador.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const pagina = await contexto.newPage();

  const erros = [];
  const avisos = [];
  pagina.on('console', m => {
    if (m.type() === 'error') erros.push('console: ' + m.text());
    if (m.type() === 'warning') avisos.push('aviso: ' + m.text());
  });
  pagina.on('pageerror', e => erros.push('pageerror: ' + e.message));
  pagina.on('requestfailed', r => erros.push('rede: ' + r.url() + ' — ' + (r.failure() || {}).errorText));

  await pagina.goto(base, { waitUntil: 'networkidle' });
  await pagina.waitForTimeout(1200);

  const falhas = [];
  const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALHA ') + m); if (!c) falhas.push(m); };

  console.log('\n[1] a casca subiu');
  ok(await pagina.locator('#prato').count() === 1, 'o prato existe');
  ok(await pagina.locator('#braco').count() === 1, 'o braço existe');
  ok((await pagina.title()).length > 0, 'a página tem título: ' + await pagina.title());

  console.log('\n[2] os controles novos existem');
  for (const [sel, nome] of [
    ['#btn-repetir', 'botão de repetir'],
    ['#busca', 'campo de busca'],
    ['#btn-fila', 'ver a fila'],
    ['#btn-tocar', 'tocar'],
    ['#btn-menu', 'menu'],
  ]) {
    ok(await pagina.locator(sel).count() > 0, nome + ' (' + sel + ')');
  }

  console.log('\n[3] o estado interno subiu');
  const est = await pagina.evaluate(() => {
    try {
      return {
        repetir: window.__diag ? null : null,
        temIDB: !!window.indexedDB,
        html: document.documentElement.dataset.tema || document.documentElement.getAttribute('data-tema'),
        corpo: document.body.className,
      };
    } catch (e) { return { erro: String(e) }; }
  });
  ok(!est.erro, 'a página responde a script: ' + JSON.stringify(est));

  console.log('\n[4] biblioteca vazia não quebra');
  const vazio = await pagina.locator('body').innerText();
  ok(vazio.length > 0, 'tem texto na tela (' + vazio.replace(/\s+/g, ' ').slice(0, 70) + '…)');

  console.log('\n[5] o menu abre');
  try {
    await pagina.locator('#btn-menu').click({ timeout: 3000 });
    await pagina.waitForTimeout(600);
    ok(true, 'o menu não derrubou a página');
    await pagina.screenshot({ path: path.join(SAIDA, 'menu.png') });
    await pagina.keyboard.press('Escape');
    await pagina.waitForTimeout(400);
  } catch (e) {
    ok(false, 'clicar no menu: ' + e.message);
  }

  console.log('\n[6] capturas');
  await pagina.screenshot({ path: path.join(SAIDA, 'biblioteca.png') });
  await contexto.close();

  const claro = await navegador.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, colorScheme: 'light',
  });
  const p2 = await claro.newPage();
  p2.on('pageerror', e => erros.push('pageerror(claro): ' + e.message));
  await p2.goto(base, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(1000);
  await p2.screenshot({ path: path.join(SAIDA, 'claro.png') });
  console.log('  ok    biblioteca.png, claro.png e menu.png gravadas em ' + SAIDA);

  await navegador.close();
  servidor.close();

  console.log('\n[7] console limpo');
  if (erros.length) { erros.forEach(e => console.log('  FALHA ' + e)); falhas.push('console sujo'); }
  else console.log('  ok    nenhum erro de console, de página ou de rede');
  if (avisos.length) avisos.slice(0, 5).forEach(a => console.log('  (aviso) ' + a));

  console.log('\n' + (falhas.length === 0 ? 'TUDO PASSOU' : falhas.length + ' FALHA(S)'));
  process.exit(falhas.length ? 1 : 0);
})();
