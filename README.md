---
titulo: "Vitrola — player de música em HTML, CSS e JS"
area: projetos
tipo: projeto
grupo: vitrola
tags:
  - projeto
  - musica
  - javascript
  - design
atualizado: 2026-08-04
---

# ◉ Vitrola

Toca os MP3 do seu computador. Lê as etiquetas do arquivo, tira a cor que manda na capa e **tematiza a interface inteira com ela**.

**HTML, CSS e JavaScript puros** — sem biblioteca, sem build, sem servidor. Nada sai da sua máquina: não há upload, porque não há para onde subir.

| Arquivo | O que é |
|---|---|
| [index.html](index.html) | A página |
| [style.css](style.css) | A aparência — a parte que é o produto |
| [app.js](app.js) | Tudo o mais, em 10 seções numeradas |
| [testes/testar.js](testes/testar.js) | Carrega o `app.js` num DOM falso e testa a lógica pura |

---

## A ideia visual

A referência é o **selo Elenco** — as capas que Aloysio Magalhães desenhou no começo dos anos 60. Preto, branco e **uma** cor chapada. Tipografia pesada e apertada, muito espaço vazio.

Isso resolveu o problema central de graça: o requisito "a cor da capa tematiza a interface" *é* o sistema da Elenco. A cor extraída vira a única cor.

Daí a regra que manda em tudo:

> **A cor de acento não existe até entrar uma faixa.** A interface nasce em preto e branco, e é o álbum que a colore.

O acento fica preso a quatro lugares — a onda, o progresso, a faixa ativa na fila e um fio. Todo o resto permanece preto e branco. Ousadia em um lugar só; o entorno quieto.

### Os neutros foram medidos, não escolhidos a olho

Três níveis de texto, cada um com contraste conferido contra o fundo do seu tema:

| Token | Papel | Claro | Escuro |
|---|---|---|---|
| `--texto` | título, corpo | 15,9:1 | 15,9:1 |
| `--fraco` | artista, rótulos | 7,2:1 | 6,9:1 |
| `--tenue` | número, duração, álbum, rodapé | 4,5:1 | 4,6:1 |
| `--limite` | trilho do volume, onda não tocada | 3,0:1 | 3,0:1 |

A escala é comprimida de propósito. Um cinza mais claro que `--tenue` ficaria bonito e ilegível — o valor que eu tinha antes media **1,93:1**, e estava no número da faixa, na duração, no álbum e no rodapé.

**Uma exceção, deliberada:** `--borda` fica em 1,2:1 e não é um defeito. O WCAG 1.4.11 cobre o que é preciso para identificar um componente ou entender o conteúdo; um filete decorativo entre seções não é nem um nem outro. Onde o contorno de fato informa — o trilho do volume, a parte não tocada da onda — existe `--limite`, e ele passa em 3:1.

---

## O que tem dentro

### Um leitor de ID3 escrito à mão

Sem biblioteca. Lê **ID3v2.2, v2.3 e v2.4** — título, artista, álbum, ano, faixa e a capa embutida (quadros `APIC` e `PIC`) — e cai para o **ID3v1** dos 128 bytes finais quando não há v2. Sem etiqueta nenhuma, usa o nome do arquivo.

Duas asperezas do formato que o código trata de propósito:

- **Tamanho sincro-seguro.** No v2.4 o tamanho do quadro usa 7 bits por byte, para nunca imitar um quadro de sincronismo de MP3. Só que há codificador que grava v2.4 com tamanho comum, fora da norma. O leitor tenta a leitura correta e, se o próximo quadro não fizer sentido, tenta a outra.
- **Quatro codificações de texto** por quadro (`ISO-8859-1`, `UTF-16` com BOM, `UTF-16BE`, `UTF-8`), e a descrição da capa terminando em nulo **duplo** quando o texto é UTF-16.

### A cor, e o problema que ela cria

Achar a cor dominante é a parte fácil: reduz a capa a 56×56, joga os pixels em 30 faixas de matiz e pondera por viveza — assim um detalhe saturado ganha de uma área grande e barrenta. Cinza e os extremos de luminosidade ficam de fora.

O problema é o seguinte: **capa clara gera cor clara, que some no fundo claro.** Então a cor extraída passa por correção de luminosidade até bater **4,5:1 de contraste WCAG** contra o fundo do tema em vigor — e é recalculada quando você troca o tema, porque o alvo muda.

A matiz nunca é tocada. Só a luminosidade. O amarelo continua amarelo:

| Cor extraída | Tema claro | Tema escuro |
|---|---|---|
| amarelo `l=0.60` | `l=0.24` — 4,6:1 | `l=0.60` — 14,5:1 |

### A onda é a barra de progresso

Não é desenho decorativo. A faixa é decodificada e reduzida a mil picos reais de amplitude, e é isso que você vê e arrasta. A decodificação acontece **depois** do play começar — a música nunca espera pelo desenho.

Ela é decodificada num `OfflineAudioContext` descartável, de propósito: usar o contexto de reprodução ali seria uma armadilha, porque ele nasceria fora de um clique, e um `AudioContext` suspenso com o `<audio>` ligado nele **toca em silêncio**.

### Media Session

Capa, título e artista aparecem **na tela de bloqueio do celular**, com os controles do sistema funcionando — inclusive arrastar a posição. São poucas linhas e quase ninguém implementa.

### É um aplicativo de celular

Vitrola é um **PWA**: instala na tela inicial, abre em tela cheia sem barra de navegador e funciona sem rede.

| | |
|---|---|
| **Instalar** | Android: o botão *Instalar* aparece sozinho na barra de cima. iOS: Safari → Compartilhar → *Adicionar à Tela de Início* |
| **Sem rede** | O service worker guarda a casca inteira. Depois da primeira visita, abre no avião |
| **Compartilhar para a Vitrola** | No Android ela aparece na folha de compartilhamento de qualquer app. O service worker recebe o POST, guarda os arquivos e a página os recolhe |
| **Abrir com** | Com o app instalado, tocar num arquivo de áudio pode abrir a Vitrola direto |
| **Tela de bloqueio** | Capa, título, artista e os controles do sistema, pela Media Session |
| **Áreas seguras** | `env(safe-area-inset-*)` no padding — instalado no iOS o conteúdo passaria por baixo do relógio |

Duas decisões de produto que valem dizer:

- **O controle de volume some no telefone.** O aparelho já tem um, no lado. Repetir na tela roubava largura do transporte, que é o que se usa de fato. O botão de mudo fica — silenciar depressa é outra intenção.
- **A capa é limitada pela altura, não pela largura.** Em pé, uma capa quadrada de largura total empurra os controles para baixo da dobra. Num player, ter de rolar para dar pausa é defeito.

> [!warning] PWA exige HTTPS
> Aberto por duplo clique (`file://`) o registro do service worker falha — de propósito, em silêncio. O player continua inteiro, só sem instalar e sem offline. Para instalar de verdade, tem de vir de um endereço `https://`.

**No iOS há limite:** a Apple não oferece o botão de instalar (é pelo menu Compartilhar), não implementa `share_target`, e reprodução em segundo plano num PWA é menos confiável que no Android. Nada disso quebra o app — apenas não é igual nos dois.

### Some mais

- **A fila sobrevive ao recarregar** — os arquivos ficam no IndexedDB do navegador
- Arrastar e soltar em qualquer lugar da página
- Tema claro e escuro, com preferência do sistema respeitada e botão que vence nos dois sentidos
- Aleatório, repetir tudo, repetir uma
- Teclado inteiro: <kbd>espaço</kbd> <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>S</kbd> <kbd>R</kbd> <kbd>M</kbd>
- Espectro ao vivo pelo `AnalyserNode`, em escala logarítmica — que é a que corresponde ao que o ouvido percebe

---

## O que foi verificado

```bash
node testes/testar.js
```

| | |
|---|---|
| ID3v2.3 — UTF-16 com acento, latin1, capa PNG | ✅ |
| ID3v2.4 — tamanho sincro-seguro, UTF-8, `TDRC` | ✅ |
| ID3v2.2 — identificadores de 3 letras, quadro `PIC` | ✅ |
| Queda para ID3v1, e daí para o nome do arquivo | ✅ |
| Arquivo torto e arquivo de zero byte não derrubam o leitor | ✅ |
| Ida e volta RGB↔HSL — erro máximo **0** de 255 | ✅ |
| Correção de contraste — **648/648** cores chegam a 4,5:1, nos dois temas | ✅ |
| Formatação de tempo, inclusive `NaN` e negativo | ✅ |
| Todo par frente/fundo dos tokens, medido nos dois temas | ✅ 13/13 |

**Não verificado:** som, o desenho da onda e do espectro, Media Session no celular e o toque. Isso só olhando.

---

## Onde mexer

| Quero… | Vá em |
|---|---|
| Trocar os neutros ou a tipografia | topo do `style.css` |
| Mudar o alvo de contraste | `ALVO_CONTRASTE`, seção 3 |
| Mudar como a cor dominante é escolhida | `corDaImagem()`, seção 3 |
| Suportar mais quadros de ID3 | o mapa `CAMPO`, seção 2 |
| Mudar o desenho da onda ou do espectro | seção 7 |

---

## Licença

MIT — ver [LICENSE](LICENSE). A referência à Elenco é de linguagem visual, não de reprodução: nenhuma arte, marca ou tipografia do selo foi usada.
