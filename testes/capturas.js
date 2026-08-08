/* Gera as capturas do README com a biblioteca cheia — MP3 sinteticos, com
   etiqueta e capa de verdade, entregues pelo <input type=file>. Sem isso a
   captura sai da tela vazia, que nao mostra o aplicativo.

   Uso:  node testes/capturas.js <pasta do app> <pasta com os mp3> <destino>

   Nao ha musica no repo (nao e minha para distribuir — ver .gitignore). Os
   MP3 de teste se fabricam com ffmpeg, um por vez:

     ffmpeg -f lavfi -i color=c=0x2E6F5E:s=300x300:d=1 -frames:v 1 capa.png
     ffmpeg -f lavfi -i sine=frequency=220:duration=254 -i capa.png \
            -map 0:a -map 1:v -c:a libmp3lame -b:a 128k -c:v copy \
            -id3v2_version 3 -metadata title="Construcao" \
            -metadata artist="Chico Buarque" -metadata album="Construcao" \
            -metadata:s:v comment="Cover (front)" 01.mp3

   Capas de cores diferentes de propósito: e a cor da capa que tinge a
   interface, e uma captura com quatro capas iguais nao mostraria isso.

   Precisa do Playwright. Se o script rodar de fora da raiz que tem o
   node_modules, exportar NODE_PATH apontando pra ela. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const RAIZ = path.resolve(process.argv[2]);
const MP3 = path.resolve(process.argv[3]);
const SAIDA = path.resolve(process.argv[4]);

const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

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

const erros = [];

async function sessao(navegador, tema) {
  const ctx = await navegador.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, colorScheme: tema,
  });
  // O padrao do aplicativo e 'escuro' — nao 'sistema'. So mudar o colorScheme
  // do navegador nao vira o tema; a preferencia e que manda.
  await ctx.addInitScript(t => {
    try { localStorage.setItem('vitrola:tema', JSON.stringify(t)); } catch (_) {}
  }, tema === 'light' ? 'claro' : 'escuro');
  const p = await ctx.newPage();
  p.on('pageerror', e => erros.push(`pageerror(${tema}): ` + e.message));
  p.on('console', m => { if (m.type() === 'error') erros.push(`console(${tema}): ` + m.text()); });
  return { ctx, p };
}

async function carregar(p, base) {
  await p.goto(base, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const arquivos = fs.readdirSync(MP3).filter(a => a.endsWith('.mp3')).map(a => path.join(MP3, a));
  await p.setInputFiles('#arquivos', arquivos);
  // ler etiqueta + decodificar picos leva um tempo; espero a lista encher
  await p.waitForFunction(() => document.querySelectorAll('.linha, .faixa, li').length >= 4,
                          null, { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(2500);
}

(async () => {
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${servidor.address().port}/`;
  const navegador = await chromium.launch();

  // --- escuro: biblioteca + tocando
  {
    const { ctx, p } = await sessao(navegador, 'dark');
    await carregar(p, base);
    // o recado ("Construção — Chico Buarque") some sozinho; esperar, senao
    // ele tapa o mini player justamente na captura
    await p.waitForTimeout(4000);
    await p.screenshot({ path: path.join(SAIDA, 'biblioteca.png') });
    console.log('  ok    biblioteca.png');

    // mini player -> tela de tocando; deixar tocar para o braco descer
    await p.locator('#mini-abrir').click({ timeout: 5000 })
      .catch(e => erros.push('abrir tocando: ' + e.message));
    await p.waitForTimeout(1200);
    await p.locator('#btn-tocar').click({ timeout: 5000 })
      .catch(e => erros.push('dar play: ' + e.message));
    await p.waitForTimeout(6000);
    await p.screenshot({ path: path.join(SAIDA, 'tocando.png') });
    console.log('  ok    tocando.png');
    await ctx.close();
  }

  // --- claro: biblioteca
  {
    const { ctx, p } = await sessao(navegador, 'light');
    await carregar(p, base);
    await p.waitForTimeout(4000);
    await p.screenshot({ path: path.join(SAIDA, 'claro.png') });
    console.log('  ok    claro.png');
    await ctx.close();
  }

  await navegador.close();
  servidor.close();

  if (erros.length) { console.log('\nERROS:'); erros.forEach(e => console.log('  ' + e)); }
  else console.log('\nsem erro de console');
})();
