/* Confere o que o GitHub Pages esta servindo AGORA — nao a copia local.
   Carrega o site, poe os MP3 pelo seletor, toca, e olha o console.

   Uso:  node testes/fumaca_ao_vivo.js <pasta com os mp3> <destino da captura>

   Existe porque passar na copia local nao prova publicacao: a estrategia do
   service worker e cache-primeiro, e sem subir o VERSAO no sw.js o site
   continua servindo a casca antiga para quem ja instalou. Este roteiro olha
   justamente isso — qual cache o navegador registrou depois de abrir o site
   de verdade.

   Rodar DEPOIS do push, e dar um minuto para o Pages publicar. */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const MP3 = path.resolve(process.argv[2]);
const SAIDA = path.resolve(process.argv[3]);
const URL = 'https://skotalexsander.github.io/vitrola/';

(async () => {
  const navegador = await chromium.launch();
  const ctx = await navegador.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();
  const erros = [];
  p.on('pageerror', e => erros.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') erros.push('console: ' + m.text()); });
  // blob: abortado NAO e defeito: a sonda de duracao devolve o objectURL assim
  // que o metadado chega, e o navegador cancela o resto do download. E a
  // limpeza funcionando — o que sobraria e memoria parada.
  p.on('requestfailed', r => {
    if (r.url().startsWith('blob:')) return;
    erros.push('rede: ' + r.url() + ' — ' + (r.failure() || {}).errorText);
  });

  const falhas = [];
  const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALHA ') + m); if (!c) falhas.push(m); };

  await p.goto(URL, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);

  console.log('\n[1] e a 3.0 mesmo que esta servindo');
  ok(await p.locator('#prato').count() === 1, 'o prato existe (so a 3.0 tem)');
  ok(await p.locator('#busca').count() === 1, 'a busca existe (so a 3.0 tem)');

  console.log('\n[2] o service worker registrou');
  const sw = await p.evaluate(async () => {
    const rs = await navigator.serviceWorker.getRegistrations();
    return rs.length ? (rs[0].active ? 'ativo' : 'instalando') : 'nenhum';
  });
  ok(sw !== 'nenhum', 'service worker: ' + sw);

  // O esperado sai do sw.js LOCAL, nao esta cravado aqui: assim este teste
  // pega os dois esquecimentos de uma vez — nao subiu o VERSAO, ou subiu e
  // nao empurrou. Cravar o numero faria o teste envelhecer junto com o bug.
  const local = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  const esperado = (local.match(/VERSAO\s*=\s*'([^']+)'/) || [])[1];
  ok(!!esperado, 'li o VERSAO do sw.js local: ' + esperado);
  const cache = await p.evaluate(() => caches.keys());
  ok(cache.includes(esperado),
     'o cache publicado bate com o local (' + esperado + '): ' + JSON.stringify(cache));

  console.log('\n[3] toca de verdade');
  await p.setInputFiles('#arquivos', fs.readdirSync(MP3).filter(a => a.endsWith('.mp3')).map(a => path.join(MP3, a)));
  await p.waitForTimeout(5000);
  const parado = await p.evaluate(() => {
    const a = document.querySelector('audio');
    return a ? { pausado: a.paused, fonte: !!a.src } : null;
  });
  ok(parado && parado.fonte, 'o <audio> recebeu a faixa');
  ok(parado && parado.pausado, 'e NAO comecou a tocar sozinho (e o certo)');

  // agora o play de verdade, pelo botao
  await p.locator('#mini-tocar').click({ timeout: 5000 })
    .catch(e => falhas.push('clicar em tocar: ' + e.message));
  await p.waitForTimeout(3000);
  const tocando = await p.evaluate(() => {
    const a = document.querySelector('audio');
    return { pausado: a.paused, tempo: a.currentTime, dur: a.duration };
  });
  ok(!tocando.pausado && tocando.tempo > 0,
     'depois do play o relogio anda: ' + JSON.stringify(tocando));
  ok(tocando.dur > 100, 'a duracao foi lida do arquivo: ' + Math.round(tocando.dur) + 's');

  console.log('\n[4] instalavel');
  const man = await p.evaluate(async () => {
    const r = await fetch('manifest.webmanifest');
    return r.ok ? (await r.json()).name : 'FALHOU ' + r.status;
  });
  ok(man === 'Vitrola', 'o manifesto responde: ' + man);

  await p.screenshot({ path: path.join(SAIDA, 'ao-vivo.png') });
  await navegador.close();

  console.log('\n[5] console limpo');
  if (erros.length) { erros.forEach(e => console.log('  FALHA ' + e)); falhas.push('console sujo'); }
  else console.log('  ok    nenhum erro');

  console.log('\n' + (falhas.length === 0 ? 'TUDO PASSOU (no ar)' : falhas.length + ' FALHA(S)'));
  process.exit(falhas.length ? 1 : 0);
})();
