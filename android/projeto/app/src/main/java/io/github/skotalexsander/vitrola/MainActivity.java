package io.github.skotalexsander.vitrola;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

import androidx.webkit.WebViewAssetLoader;

/**
 * A Vitrola inteira roda de dentro do pacote.
 *
 * Os arquivos sao servidos por WebViewAssetLoader em
 * https://appassets.androidplatform.net/assets/ — nao e a internet, e um
 * atalho que o proprio WebView intercepta antes de sair para a rede. Usar
 * https (e nao file://) importa: sem ORIGEM SEGURA o Android nega
 * IndexedDB e Web Audio, e sem esses dois nao ha fila guardada nem
 * espectro reagindo a musica.
 */
public class MainActivity extends Activity implements ServicoMidia.Ouvinte {

    private static final String INICIO =
            "https://appassets.androidplatform.net/assets/index.html";
    private static final int PEDIDO_ARQUIVO = 4711;

    /** Os mesmos valores do CSS. Se divergirem, aparece uma emenda de dois
     *  pretos diferentes entre a barra do sistema e o conteudo. */
    private static final int ESCURO = 0xFF0B0B0D;
    private static final int CLARO  = 0xFFF4F5F7;

    private WebView web;
    private ValueCallback<Uri[]> aoEscolherArquivos;
    private boolean temaClaro = false;

    /** Qual estilo de dialogo usar. O tema da Activity e fixo e escuro
     *  (o windowBackground do styles.xml), entao um dialogo padrao sairia
     *  branco por cima do app escuro. Este acompanha o que a pagina disse. */
    private int temaEscolhido() {
        return temaClaro
                ? android.R.style.Theme_DeviceDefault_Light_Dialog_Alert
                : android.R.style.Theme_DeviceDefault_Dialog_Alert;
    }

    private void pintarBarras(boolean claro) {
        int cor = claro ? CLARO : ESCURO;
        android.view.Window janela = getWindow();
        janela.setStatusBarColor(cor);
        janela.setNavigationBarColor(cor);
        if (web != null) web.setBackgroundColor(cor);

        // fundo claro pede icone escuro na barra, senao some
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            android.view.View raiz = janela.getDecorView();
            int f = raiz.getSystemUiVisibility();
            if (claro) f |= android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else       f &= ~android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                if (claro) f |= android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                else       f &= ~android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            raiz.setSystemUiVisibility(f);
        }
    }

    @Override
    protected void onCreate(Bundle estado) {
        super.onCreate(estado);

        final WebViewAssetLoader carregador = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        getWindow().addFlags(
                android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);

        web = new WebView(this);
        web.setBackgroundColor(ESCURO);

        // Ponte para a pagina avisar qual tema escolheu, e as barras do
        // sistema acompanharem. Sem isso, no tema claro o aplicativo vira
        // um cartao branco dentro de uma moldura preta.
        //
        // addJavascriptInterface tem fama ruim, e com razao quando a pagina
        // vem da rede. Aqui nao vem: todo o conteudo esta dentro do pacote
        // e o aplicativo nem pede permissao de internet. Nao existe origem
        // de fora que possa alcancar esta ponte.
        web.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void tema(String t) {
                final boolean claro = "claro".equals(t);
                temaClaro = claro;
                runOnUiThread(new Runnable() {
                    @Override public void run() { pintarBarras(claro); }
                });
            }

            /** A pagina conta o que esta tocando; o servico transforma isso
             *  no card da tela de bloqueio e da aba de notificacao. */
            @android.webkit.JavascriptInterface
            public void midia(final String titulo, final String artista,
                              final String album, final boolean tocando,
                              final long durMs, final long posMs,
                              final String capaBase64) {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        pedirPermissaoDeAviso();
                        ServicoMidia.empurrar(MainActivity.this, titulo, artista,
                                album, tocando, durMs, posMs, capaBase64);
                    }
                });
            }

            /**
             * O aplicativo falando de si mesmo.
             *
             * A tela de bloqueio depende de tres pecas que so existem do
             * lado Android — a permissao de notificacao, o servico de
             * primeiro plano e a sessao de midia — e quando uma falha, ela
             * falha CALADA: some o card e ninguem diz por que. Sem isto a
             * unica saida seria compilar uma versao nova a cada palpite.
             */
            @android.webkit.JavascriptInterface
            public String diagnostico() {
                StringBuilder s = new StringBuilder();
                s.append("Vitrola ").append(versaoDoPacote()).append("\n");
                s.append("Android ").append(Build.VERSION.RELEASE)
                 .append(" (API ").append(Build.VERSION.SDK_INT).append(")").append("\n");
                s.append("aparelho: ").append(Build.MANUFACTURER)
                 .append(" ").append(Build.MODEL).append("\n\n");

                s.append("permissao de notificacao: ").append(estadoDoAviso()).append("\n");
                s.append("servico de midia: ")
                 .append(ServicoMidia.dePe() ? "de pe" : "parado").append("\n");
                s.append("sessao de midia: ")
                 .append(ServicoMidia.sessaoAtiva() ? "ativa" : "inativa").append("\n");
                return s.toString();
            }

            /** Fila esvaziada, ou nada mais carregado: tira o card. */
            @android.webkit.JavascriptInterface
            public void pararMidia() {
                runOnUiThread(new Runnable() {
                    @Override public void run() { ServicoMidia.encerrar(MainActivity.this); }
                });
            }
        }, "Sistema");

        // O servico manda de volta o que o usuario tocou no card. Quem
        // executa e o JavaScript: o <audio> vive la, nao aqui.
        ServicoMidia.ouvir(this);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // sem isto o WebView exige um toque antes de qualquer audio, e
        // "tocar a proxima faixa sozinho" nao funcionaria
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest p) {
                return carregador.shouldInterceptRequest(p.getUrl());
            }
        });

        // Sem isto o <input type="file"> nao abre nada: dentro de um WebView
        // o seletor de arquivos e responsabilidade do aplicativo, nao do
        // navegador. E aqui que "escolher as musicas" acontece.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> retorno,
                                             FileChooserParams parametros) {
                if (aoEscolherArquivos != null) {
                    aoEscolherArquivos.onReceiveValue(null);
                }
                aoEscolherArquivos = retorno;

                // Monto o pedido a mao em vez de confiar no createIntent():
                // ele monta o filtro a partir do atributo accept do HTML, e
                // em alguns aparelhos isso abre um seletor VAZIO. Se este
                // falhar, ai sim caio no que o WebView sugeria.
                Intent meu = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                meu.addCategory(Intent.CATEGORY_OPENABLE);
                meu.setType("audio/*");
                meu.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(meu, PEDIDO_ARQUIVO);
                    return true;
                } catch (Exception primeiro) {
                    try {
                        Intent reserva = parametros.createIntent();
                        reserva.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                        startActivityForResult(
                                Intent.createChooser(reserva, "Escolher músicas"),
                                PEDIDO_ARQUIVO);
                        return true;
                    } catch (Exception segundo) {
                        aoEscolherArquivos = null;
                        return false;
                    }
                }
            }

            // O botao de lapis da lista chama window.prompt() para corrigir
            // titulo e artista na mao. Dentro de um WebView isso NAO e
            // garantido: quando o WebChromeClient nao trata onJsPrompt, o
            // que acontece depende da versao do Android — na melhor das
            // hipoteses sai um dialogo de sistema que nao combina com nada,
            // na pior o prompt volta null e o botao simplesmente nao faz
            // nada. Trato aqui para nao depender de sorte, e de quebra o
            // dialogo segue o tema escolhido.
            @Override
            public boolean onJsPrompt(WebView v, String url, String mensagem,
                                      String padrao, final JsPromptResult r) {
                final EditText campo = new EditText(MainActivity.this);
                campo.setSingleLine(true);
                campo.setInputType(InputType.TYPE_CLASS_TEXT
                        | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
                if (padrao != null) {
                    campo.setText(padrao);
                    campo.setSelection(padrao.length());   // cursor no fim, nao no comeco
                }

                // margem lateral: sem isto o campo encosta na borda do dialogo
                FrameLayout moldura = new FrameLayout(MainActivity.this);
                int m = Math.round(20 * getResources().getDisplayMetrics().density);
                FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.WRAP_CONTENT);
                lp.setMargins(m, m / 2, m, 0);
                moldura.addView(campo, lp);

                AlertDialog d = new AlertDialog.Builder(MainActivity.this, temaEscolhido())
                        .setTitle(mensagem)
                        .setView(moldura)
                        .setPositiveButton("Salvar", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface di, int q) {
                                r.confirm(campo.getText().toString());
                            }
                        })
                        .setNegativeButton("Cancelar", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface di, int q) {
                                r.cancel();
                            }
                        })
                        // tocar fora, ou o botao voltar, tem de responder
                        // alguma coisa: um JsPromptResult que nunca recebe
                        // confirm nem cancel deixa o JavaScript pendurado.
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override public void onCancel(DialogInterface di) { r.cancel(); }
                        })
                        .create();
                d.show();
                return true;
            }

            @Override
            public boolean onJsAlert(WebView v, String url, String mensagem,
                                     final JsResult r) {
                new AlertDialog.Builder(MainActivity.this, temaEscolhido())
                        .setMessage(mensagem)
                        .setPositiveButton("Certo", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface di, int q) { r.confirm(); }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override public void onCancel(DialogInterface di) { r.cancel(); }
                        })
                        .create().show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView v, String url, String mensagem,
                                       final JsResult r) {
                new AlertDialog.Builder(MainActivity.this, temaEscolhido())
                        .setMessage(mensagem)
                        .setPositiveButton("Sim", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface di, int q) { r.confirm(); }
                        })
                        .setNegativeButton("Nao", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface di, int q) { r.cancel(); }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override public void onCancel(DialogInterface di) { r.cancel(); }
                        })
                        .create().show();
                return true;
            }
        });

        setContentView(web);
        web.loadUrl(INICIO);
    }

    @Override
    protected void onActivityResult(int pedido, int resultado, Intent dados) {
        if (pedido != PEDIDO_ARQUIVO) {
            super.onActivityResult(pedido, resultado, dados);
            return;
        }
        if (aoEscolherArquivos == null) {
            return;
        }
        aoEscolherArquivos.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(resultado, dados));
        aoEscolherArquivos = null;
    }

    /**
     * O botao fisico de voltar pergunta a pagina primeiro. E uma pagina so,
     * sem historico de navegacao, entao sem isto voltar sairia do aplicativo
     * mesmo estando no player — o contrario do que a seta na tela faz.
     */
    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript(
                "(window.__voltar && window.__voltar()) ? 'sim' : 'nao'",
                new android.webkit.ValueCallback<String>() {
                    @Override public void onReceiveValue(String r) {
                        if (r == null || !r.contains("sim")) fechar();
                    }
                });
    }

    private void fechar() {
        moveTaskToBack(true);   // sai sem destruir: voltar retoma onde parou
    }

    /* ------------------------------------------------- controles do sistema */

    /**
     * O que o usuario tocou no card da tela de bloqueio, ou no fone.
     * Chega em qualquer thread e sai no JavaScript, que e onde o <audio>
     * de fato existe — daqui nao da para mandar em som nenhum.
     *
     * "qual" vem sempre de uma constante minha, nunca do sistema, entao
     * nao ha texto de fora entrando na chamada de JavaScript.
     */
    @Override
    public void comando(final String qual, final long argumento) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (web == null) return;
                web.evaluateJavascript(
                        "window.__midia && window.__midia('" + qual + "', " + argumento + ")",
                        null);
            }
        });
    }

    /**
     * Do Android 13 em diante a notificacao so aparece com permissao, e o
     * card da tela de bloqueio E a notificacao. Peco na primeira vez que
     * algo toca, e nao na abertura: perguntar antes de existir musica e
     * pedir sem ter o que mostrar.
     */
    private String versaoDoPacote() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Throwable e) {
            return "?";
        }
    }

    /** Antes do Android 13 a permissao nem existe — dizer "negada" ali
     *  mandaria procurar defeito onde nao ha. */
    private String estadoDoAviso() {
        if (Build.VERSION.SDK_INT < 33) return "nao se aplica (Android 12 ou menor)";
        try {
            boolean tem = checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
            if (tem) return "concedida";
            return jaPediuAviso ? "NEGADA — sem ela o card nao aparece"
                                : "ainda nao pedida (toque uma musica)";
        } catch (Throwable e) {
            return "nao deu para saber";
        }
    }

    private boolean jaPediuAviso = false;
    private void pedirPermissaoDeAviso() {
        if (jaPediuAviso || Build.VERSION.SDK_INT < 33) return;
        jaPediuAviso = true;
        try {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 91);
            }
        } catch (Throwable e) {}
    }

    @Override
    protected void onDestroy() {
        ServicoMidia.ouvir(null);
        ServicoMidia.encerrar(this);
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
