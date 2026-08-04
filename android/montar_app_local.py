#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Monta um aplicativo Android LOCAL de verdade.

Diferenca para o APK anterior: aquele era um TWA, uma casca que abria o
site pela rede. Este carrega os arquivos de DENTRO do proprio pacote, por
WebViewAssetLoader, e nem pede permissao de INTERNET no manifesto. Sem
rede ele funciona igual, porque nunca precisou de rede.
"""
import math, os, shutil, struct, zlib

RAIZ   = os.path.join(os.environ["USERPROFILE"], ".bubblewrap")
BASE   = os.path.join(RAIZ, "vitrola-apk")        # de onde vem o wrapper do gradle
OBRA   = os.path.join(RAIZ, "vitrola-local")
WEB    = r"B:\Projeto 9 Claude Mestre Neutro\10-projetos\vitrola"
PACOTE = "io.github.skotalexsander.vitrola"

shutil.rmtree(OBRA, ignore_errors=True)
os.makedirs(OBRA, exist_ok=True)

def escrever(caminho, texto):
    p = os.path.join(OBRA, caminho)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(texto)

# ------------------------------------------------------- wrapper do gradle
for nome in ("gradlew", "gradlew.bat"):
    shutil.copy(os.path.join(BASE, nome), os.path.join(OBRA, nome))
shutil.copytree(os.path.join(BASE, "gradle"), os.path.join(OBRA, "gradle"))
print("[1] wrapper do gradle reaproveitado (8.11.1, ja em cache)")

# ---------------------------------------------------------------- gradle
escrever("settings.gradle", "rootProject.name = 'Vitrola'\ninclude ':app'\n")

escrever("gradle.properties",
         "org.gradle.jvmargs=-Xmx2048m\n"
         "android.useAndroidX=true\n"
         "android.nonTransitiveRClass=true\n")

escrever("build.gradle", """buildscript {
    repositories { google(); mavenCentral() }
    dependencies { classpath 'com.android.tools.build:gradle:8.9.1' }
}
allprojects {
    repositories { google(); mavenCentral() }
}
""")

escrever("app/build.gradle", """apply plugin: 'com.android.application'

android {
    namespace "PACOTE"
    compileSdk 36

    defaultConfig {
        applicationId "PACOTE"
        minSdk 21
        targetSdk 36
        // versao 2: mesmo pacote e mesma chave do APK anterior, entao este
        // instala POR CIMA daquele, como atualizacao
        versionCode 2
        versionName "2.0.0"
    }

    signingConfigs {
        release {
            storeFile file(System.getenv("VITROLA_KEYSTORE"))
            storePassword System.getenv("VITROLA_SENHA")
            keyAlias "vitrola"
            keyPassword System.getenv("VITROLA_SENHA")
        }
    }

    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
        }
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
}

dependencies {
    implementation 'androidx.webkit:webkit:1.12.1'
}
""".replace("PACOTE", PACOTE))

# ------------------------------------------------------------- manifesto
# Sem <uses-permission INTERNET>: nao e esquecimento, e a prova de que o
# aplicativo e local. Se um dia ele tentar buscar algo na rede, falha.
escrever("app/src/main/AndroidManifest.xml", """<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:label="Vitrola"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher"
        android:theme="@style/TemaVitrola"
        android:hardwareAccelerated="true"
        android:allowBackup="true"
        android:usesCleartextTraffic="false">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTask"
            android:configChanges="orientation|screenSize|screenLayout|keyboardHidden|uiMode|density">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
""")

escrever("app/src/main/res/values/themes.xml", """<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="TemaVitrola" parent="android:Theme.Material.NoActionBar">
        <item name="android:colorBackground">#0B0B0D</item>
        <item name="android:windowBackground">#0B0B0D</item>
        <item name="android:statusBarColor">#0B0B0D</item>
        <item name="android:navigationBarColor">#0B0B0D</item>
    </style>
</resources>
""")

# --------------------------------------------------------------- a Activity
ACTIVITY = '''package PACOTE;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

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
public class MainActivity extends Activity {

    private static final String INICIO =
            "https://appassets.androidplatform.net/assets/index.html";
    private static final int PEDIDO_ARQUIVO = 4711;

    /** Os mesmos valores do CSS. Se divergirem, aparece uma emenda de dois
     *  pretos diferentes entre a barra do sistema e o conteudo. */
    private static final int ESCURO = 0xFF0B0B0D;
    private static final int CLARO  = 0xFFF4F5F7;

    private WebView web;
    private ValueCallback<Uri[]> aoEscolherArquivos;

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
                runOnUiThread(new Runnable() {
                    @Override public void run() { pintarBarras(claro); }
                });
            }
        }, "Sistema");

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
                try {
                    Intent i = parametros.createIntent();
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(
                            Intent.createChooser(i, "Escolher músicas"), PEDIDO_ARQUIVO);
                    return true;
                } catch (Exception e) {
                    aoEscolherArquivos = null;
                    return false;
                }
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

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
'''
escrever("app/src/main/java/%s/MainActivity.java" % PACOTE.replace(".", "/"),
         ACTIVITY.replace("PACOTE", PACOTE))
print("[2] gradle, manifesto e Activity escritos")

# ----------------------------------------------------------- arquivos web
destino = os.path.join(OBRA, "app", "src", "main", "assets")
os.makedirs(destino, exist_ok=True)
for nome in ("index.html", "style.css", "app.js"):
    shutil.copy(os.path.join(WEB, nome), os.path.join(destino, nome))
shutil.copytree(os.path.join(WEB, "icones"), os.path.join(destino, "icones"))
# sw.js e manifest.webmanifest ficam de fora de proposito: guardar em cache
# o que ja esta dentro do pacote nao faz sentido, e manifesto de instalacao
# nao serve a um aplicativo que ja esta instalado.
n = sum(len(fs) for _, _, fs in os.walk(destino))
print(f"[3] {n} arquivos web embutidos no pacote")

# ---------------------------------------------------------------- icones
TINTA, CAL = (0x0E, 0x0E, 0x10), (0xE8, 0xE9, 0xEC)

def misturar(f, c, k):
    return tuple(round(f[i] + (c[i] - f[i]) * k) for i in range(3))

def disco(S):
    cx = cy = S / 2.0
    u = float(S)
    aneis = [(0.380, 0.005, 0.22), (0.340, 0.005, 0.22),
             (0.300, 0.005, 0.22), (0.255, 0.005, 0.22)]
    linhas = []
    for y in range(S):
        linha = bytearray()
        for x in range(S):
            d = math.hypot(x + .5 - cx, y + .5 - cy) / u
            cor = CAL
            k = min(1.0, max(0.0, (0.440 - d) * u + 0.5))
            if k: cor = misturar(cor, TINTA, k)
            for r, meia, op in aneis:
                k = min(1.0, max(0.0, (meia - abs(d - r)) * u + 0.5)) * op
                if k: cor = misturar(cor, CAL, k)
            k = min(1.0, max(0.0, (0.150 - d) * u + 0.5))
            if k: cor = misturar(cor, CAL, k)
            k = min(1.0, max(0.0, (0.032 - d) * u + 0.5))
            if k: cor = misturar(cor, TINTA, k)
            linha += bytes(cor)
        linhas.append(linha)
    return linhas

def png(caminho, S, linhas):
    cru = b"".join(b"\x00" + bytes(l) for l in linhas)
    def pedaco(t, d):
        return (struct.pack(">I", len(d)) + t + d +
                struct.pack(">I", zlib.crc32(t + d) & 0xffffffff))
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    with open(caminho, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(pedaco(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 2, 0, 0, 0)))
        f.write(pedaco(b"IDAT", zlib.compress(cru, 9)))
        f.write(pedaco(b"IEND", b""))

for nome, S in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
    png(os.path.join(OBRA, "app", "src", "main", "res", "mipmap-" + nome, "ic_launcher.png"),
        S, disco(S))
print("[4] icones em 5 densidades (48 a 192)")

print("\nobra: " + OBRA)
