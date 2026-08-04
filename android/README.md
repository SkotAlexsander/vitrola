# Aplicativo Android local

`montar_app_local.py` monta, do zero, um projeto Android que roda a Vitrola
**de dentro do pacote**. Não é uma casca que abre o site: os arquivos vão
embutidos, e o manifesto **não pede permissão de internet** — sem ela o
Android não deixa o app acessar a rede nem se quisesse.

## O detalhe que faz tudo funcionar

Os arquivos são servidos por `WebViewAssetLoader` em
`https://appassets.androidplatform.net/assets/` — não é a internet, é um
atalho que o próprio WebView intercepta antes de sair para a rede.

Usar `https` e não `file://` **importa**: sem origem segura o Android nega
IndexedDB e Web Audio. Sem esses dois não há fila guardada nem espectro
reagindo à música — ou seja, o app pareceria quebrado por um motivo que não
tem nada a ver com o código.

## O outro detalhe

Dentro de um WebView, `<input type="file">` **não abre nada** por conta
própria: o seletor de arquivos é responsabilidade do aplicativo. É o
`onShowFileChooser` que faz "Adicionar músicas" existir.

## Para reconstruir

Precisa de JDK 17, Android SDK (plataforma 36, build-tools 36) e do wrapper
do Gradle. O script reaproveita o wrapper de um projeto vizinho.

```
python android/montar_app_local.py
cd %USERPROFILE%\.bubblewrap\vitrola-local
set VITROLA_KEYSTORE=<caminho da chave>
set VITROLA_SENHA=<senha>
gradlew.bat assembleRelease
```

A chave de assinatura **não está no repositório** e não deve estar. O Android
só aceita atualizar um app assinado com a mesma chave.