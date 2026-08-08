# Aplicativo Android local

A Vitrola roda **de dentro do pacote**. Não é uma casca que abre o site: os
arquivos vão embutidos, e o manifesto **não pede permissão de internet** — sem
ela o Android não deixa o app acessar a rede nem se quisesse.

## O detalhe que faz tudo funcionar

Os arquivos são servidos por `WebViewAssetLoader` em
`https://appassets.androidplatform.net/assets/` — não é a internet, é um
atalho que o próprio WebView intercepta antes de sair para a rede.

Usar `https` e não `file://` **importa**: sem origem segura o Android nega
IndexedDB e Web Audio. Sem esses dois não há biblioteca guardada nem brilho
reagindo à música — ou seja, o app pareceria quebrado por um motivo que não
tem nada a ver com o código.

## O outro detalhe

Dentro de um WebView, `<input type="file">` **não abre nada** por conta
própria: o seletor de arquivos é responsabilidade do aplicativo. É o
`onShowFileChooser` que faz "Adicionar músicas" existir.

---

## ⚠️ Leia antes de rodar `montar_app_local.py`

**O script está atrasado em relação ao aplicativo que existe.** Ele apaga a
pasta de obra (`shutil.rmtree`) e monta tudo do zero — e o que ele monta é
menos do que o app de hoje tem:

| | O script gera | O aplicativo real tem |
|---|---|---|
| Java | só `MainActivity` | `MainActivity` **e** `ServicoMidia` |
| Manifesto | sem `<service>`, sem permissões | serviço de primeiro plano + `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS` |
| Versão | `versionCode 2` / `2.0.0` | `versionCode 6` / `3.0.0` |

Rodar o script como está **derruba a tela de bloqueio** — o card some, e some
em silêncio, que é justamente o defeito que o Diagnóstico existe para achar.

Por isso as fontes de verdade do lado Java estão versionadas aqui, em
[`projeto/`](projeto/): `MainActivity.java`, `ServicoMidia.java`, o
`AndroidManifest.xml` e os dois `build.gradle`. O que o script ainda resolve
sozinho (ícones gerados, `res/`, wrapper do Gradle) continua fora.

**Enquanto o script não for atualizado, o caminho é o de baixo.**

## Compilar uma versão nova

A obra fica em `%USERPROFILE%\.bubblewrap\vitrola-local`. Precisa de JDK 17 e
do Android SDK (plataforma 36, build-tools 36) — os dois já estão em
`%USERPROFILE%\.bubblewrap\`.

```bat
:: 1. os três arquivos da web, por cima dos que estão lá
copy index.html style.css app.js %USERPROFILE%\.bubblewrap\vitrola-local\app\src\main\assets\

:: 2. subir versionCode E versionName em app\build.gradle
::    (versionCode igual ou menor: o Android recusa a instalação)

:: 3. compilar
set JAVA_HOME=%USERPROFILE%\.bubblewrap\jdk\jdk-17.0.20+8
set ANDROID_HOME=%USERPROFILE%\.bubblewrap\android_sdk
set ANDROID_SDK_ROOT=%ANDROID_HOME%
set VITROLA_KEYSTORE=<caminho da chave>
set VITROLA_SENHA=<senha>
gradlew.bat assembleRelease
```

> **`ANDROID_SDK_ROOT` tem de ir junto.** Esta máquina tem essa variável
> apontando para outro SDK (`A:\Dev\Android\Sdk`), e o Gradle **para** quando
> as duas discordam: *"Several environment variables contain different paths
> to the SDK"*. Definir só `ANDROID_HOME` falha.

Sai em `app\build\outputs\apk\release\app-release.apk`.

## Conferir antes de mandar para o aparelho

```bat
apksigner verify --print-certs app-release.apk
aapt dump badging app-release.apk
```

O **SHA-256 do certificado tem de ser igual ao do APK anterior** —
`7229e54f…88d7ad`. O Android só aceita atualizar um app assinado com a mesma
chave; com outra, a instalação é recusada e a única saída é desinstalar
(levando junto a biblioteca do usuário).

A chave de assinatura **não está no repositório** e não deve estar.
