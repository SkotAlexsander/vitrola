package io.github.skotalexsander.vitrola;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.media.AudioManager;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;
import android.view.KeyEvent;

/**
 * A tela de bloqueio e a aba de notificacao.
 *
 * O ponto que decide o desenho todo: navigator.mediaSession NAO produz
 * nada dentro de um WebView. No Chrome quem desenha aquele card e o
 * navegador, lendo a Media Session da pagina. Aqui nao ha navegador — ha
 * um WebView dentro de um aplicativo — entao o card tem de ser feito em
 * Java: uma MediaSession de verdade mais uma notificacao MediaStyle.
 *
 * O servico e de PRIMEIRO PLANO por necessidade, nao por capricho: sem
 * isso o Android encerra o processo quando a tela apaga, e a musica para
 * sozinha no meio. Ele tambem segura o foco de audio, que e o que faz a
 * musica pausar quando entra uma ligacao e voltar quando ela cai.
 */
public class ServicoMidia extends Service {

    public static final String CANAL = "vitrola.tocando";
    private static final int AVISO = 41;

    public static final String ACAO_TOCAR    = "io.github.skotalexsander.vitrola.TOCAR";
    public static final String ACAO_PAUSAR   = "io.github.skotalexsander.vitrola.PAUSAR";
    public static final String ACAO_PROXIMA  = "io.github.skotalexsander.vitrola.PROXIMA";
    public static final String ACAO_ANTERIOR = "io.github.skotalexsander.vitrola.ANTERIOR";
    public static final String ACAO_FECHAR   = "io.github.skotalexsander.vitrola.FECHAR";

    /** Quem executa de fato: a Activity, que fala com o JavaScript. */
    public interface Ouvinte {
        void comando(String qual, long argumento);
    }
    private static Ouvinte ouvinte;
    public static void ouvir(Ouvinte o) { ouvinte = o; }

    /* O estado atual mora aqui, estatico, porque quem o produz (a Activity)
       e quem o consome (este servico) vivem no mesmo processo. Mandar por
       extras de Intent seria mais cerimonioso e pior: a capa em bytes
       estoura o limite de transacao do Binder. */
    private static String titulo = "", artista = "", album = "";
    private static boolean tocando = false;
    private static long duracaoMs = 0, posicaoMs = 0;
    private static Bitmap capa = null;
    private static String capaAssinatura = "";

    private static ServicoMidia vivo;

    private MediaSession sessao;
    private BroadcastReceiver noisy;

    /** Chamado pela Activity a cada mudanca. Se o servico ainda nao subiu,
     *  sobe; se ja esta de pe, so repinta — startForegroundService a cada
     *  segundo seria caro e desnecessario. */
    public static void empurrar(Context ctx, String t, String a, String al,
                                boolean tocandoAgora, long dur, long pos,
                                String capaBase64) {
        titulo = t == null ? "" : t;
        artista = a == null ? "" : a;
        album = al == null ? "" : al;
        tocando = tocandoAgora;
        duracaoMs = dur;
        posicaoMs = pos;

        // decodificar a capa a cada timeupdate seria desperdicio; a
        // assinatura diz se e a mesma imagem de antes
        if (capaBase64 == null || capaBase64.length() == 0) {
            capa = null;
            capaAssinatura = "";
        } else {
            String assina = capaBase64.length() + ":" + capaBase64.substring(0,
                    Math.min(64, capaBase64.length()));
            if (!assina.equals(capaAssinatura)) {
                capaAssinatura = assina;
                try {
                    byte[] b = Base64.decode(capaBase64, Base64.DEFAULT);
                    capa = BitmapFactory.decodeByteArray(b, 0, b.length);
                } catch (Throwable e) {
                    capa = null;
                }
            }
        }

        if (vivo != null) {
            vivo.aplicar();
            return;
        }
        Intent i = new Intent(ctx, ServicoMidia.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Throwable e) {
            // Android 12+ recusa iniciar servico de primeiro plano com o
            // aplicativo em segundo plano. Nao e fatal: quando o usuario
            // voltar e tocar algo, sobe.
        }
    }

    public static void encerrar(Context ctx) {
        try { ctx.stopService(new Intent(ctx, ServicoMidia.class)); } catch (Throwable e) {}
    }

    /* Para o diagnostico: quando o card nao aparece, e por falta de
       permissao, por o servico nao ter subido, ou por a sessao nao estar
       ativa. Sao tres consertos diferentes. */
    public static boolean dePe() { return vivo != null; }
    public static boolean sessaoAtiva() {
        return vivo != null && vivo.sessao != null && vivo.sessao.isActive();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        vivo = this;

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel c = new NotificationChannel(
                    CANAL, "Tocando agora", NotificationManager.IMPORTANCE_LOW);
            c.setDescription("Os controles da musica na tela de bloqueio");
            c.setShowBadge(false);
            c.setSound(null, null);          // e um controle, nao um alerta
            c.enableVibration(false);
            NotificationManager nm = (NotificationManager)
                    getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(c);
        }

        sessao = new MediaSession(this, "Vitrola");
        sessao.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        sessao.setCallback(new MediaSession.Callback() {
            @Override public void onPlay()              { manda("tocar", 0); }
            @Override public void onPause()             { manda("pausar", 0); }
            @Override public void onSkipToNext()        { manda("proxima", 0); }
            @Override public void onSkipToPrevious()    { manda("anterior", 0); }
            @Override public void onSeekTo(long p)      { manda("buscar", p); }
            @Override public void onStop()              { manda("parar", 0); }
            @Override public boolean onMediaButtonEvent(Intent i) {
                // fone com botao: um toque alterna, e o sistema manda o
                // evento cru em vez de chamar onPlay/onPause
                KeyEvent k = (KeyEvent) i.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                if (k != null && k.getAction() == KeyEvent.ACTION_DOWN
                        && k.getKeyCode() == KeyEvent.KEYCODE_HEADSETHOOK) {
                    manda(tocando ? "pausar" : "tocar", 0);
                    return true;
                }
                return super.onMediaButtonEvent(i);
            }
        });
        sessao.setActive(true);

        /* Tirar o fone tem de pausar. Sem isto a musica pula para o
           alto-falante no meio do onibus, que e o defeito mais constrangedor
           que um player pode ter.

           Isto NAO e foco de audio e nao repete o erro da versao passada: e
           um aviso do sistema de que a saida de som mudou, e a unica coisa
           que faco com ele e pausar. Se o WebView tambem pausar por conta
           propria, pausar duas vezes nao faz mal — ao contrario de disputar
           foco, que fazia. */
        noisy = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(i.getAction())) {
                    manda("pausar", 0);
                }
            }
        };
        try {
            registerReceiver(noisy,
                    new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
        } catch (Throwable e) {
            noisy = null;
        }
    }

    private void manda(String qual, long arg) {
        Ouvinte o = ouvinte;
        if (o != null) o.comando(qual, arg);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int id) {
        String acao = intent == null ? null : intent.getAction();
        if (ACAO_TOCAR.equals(acao))         manda("tocar", 0);
        else if (ACAO_PAUSAR.equals(acao))   manda("pausar", 0);
        else if (ACAO_PROXIMA.equals(acao))  manda("proxima", 0);
        else if (ACAO_ANTERIOR.equals(acao)) manda("anterior", 0);
        else if (ACAO_FECHAR.equals(acao))   { manda("pausar", 0); parar(); return START_NOT_STICKY; }

        aplicar();
        return START_NOT_STICKY;
    }

    /** Repinta a sessao e a notificacao com o estado guardado. */
    void aplicar() {
        if (sessao == null) return;

        MediaMetadata.Builder m = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, titulo)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artista)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, duracaoMs);
        if (capa != null) {
            m.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, capa);
            m.putBitmap(MediaMetadata.METADATA_KEY_ART, capa);
        }
        sessao.setMetadata(m.build());

        long podeFazer = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT
                | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                | PlaybackState.ACTION_SEEK_TO
                | PlaybackState.ACTION_STOP;

        // A barra de progresso da tela de bloqueio anda sozinha: o sistema
        // extrapola a partir desta posicao e da velocidade. Por isso a
        // velocidade e 1 tocando e 0 pausado — com 1 pausado a barra
        // continuaria correndo com a musica parada.
        sessao.setPlaybackState(new PlaybackState.Builder()
                .setActions(podeFazer)
                .setState(tocando ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                          posicaoMs, tocando ? 1f : 0f, android.os.SystemClock.elapsedRealtime())
                .build());

        try {
            Notification n = montarAviso();
            startForeground(AVISO, n);
            if (!tocando && Build.VERSION.SDK_INT >= 24) {
                // pausado, o card continua na aba mas pode ser dispensado
                stopForeground(Service.STOP_FOREGROUND_DETACH);
                NotificationManager nm = (NotificationManager)
                        getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.notify(AVISO, n);
            }
        } catch (Throwable e) {
            // sem permissao de notificacao o card nao aparece; a musica
            // continua tocando, que e o que mais importa
        }
    }

    private PendingIntent paraMim(String acao) {
        Intent i = new Intent(this, ServicoMidia.class).setAction(acao);
        int bandeiras = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) bandeiras |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, acao.hashCode(), i, bandeiras);
    }

    private Notification montarAviso() {
        Intent abrir = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        int bandeiras = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) bandeiras |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent toque = PendingIntent.getActivity(this, 0, abrir, bandeiras);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CANAL)
                : new Notification.Builder(this);

        b.setSmallIcon(R.drawable.ic_aviso)
         .setContentTitle(titulo.length() > 0 ? titulo : "Vitrola")
         .setContentIntent(toque)
         .setDeleteIntent(paraMim(ACAO_FECHAR))
         .setVisibility(Notification.VISIBILITY_PUBLIC)   // aparece na tela de bloqueio
         .setOngoing(tocando)
         .setShowWhen(false);

        if (artista.length() > 0) b.setContentText(artista);
        if (capa != null) b.setLargeIcon(capa);

        b.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_media_previous, "Anterior",
                paraMim(ACAO_ANTERIOR)).build());
        b.addAction(tocando
                ? new Notification.Action.Builder(
                        android.R.drawable.ic_media_pause, "Pausar", paraMim(ACAO_PAUSAR)).build()
                : new Notification.Action.Builder(
                        android.R.drawable.ic_media_play, "Tocar", paraMim(ACAO_TOCAR)).build());
        b.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_media_next, "Proxima",
                paraMim(ACAO_PROXIMA)).build());

        Notification.MediaStyle estilo = new Notification.MediaStyle()
                .setMediaSession(sessao.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2);
        b.setStyle(estilo);

        return b.build();
    }

    /* --------------------------------------------------------- foco de audio
       NAO PEDIR. Ja pedi uma vez, e o resultado foi o aplicativo pausando
       sozinho a cada play.

       O motivo: quem toca o som e o <audio> dentro do WebView, e o WebView
       pede foco de audio por conta propria quando a reproducao comeca. Com
       o servico pedindo tambem, viravam dois pedintes dentro do MESMO
       aplicativo, e quem pede por ultimo tira o foco de quem pediu antes.
       Perdendo eu, meu ouvinte mandava pausar; perdendo o WebView, ele
       pausava a midia. Nas duas ordens dava no mesmo: play, pausa.

       Quem e dono do som e dono do foco. Este servico e dono do card. */

    private void parar() {
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
        } catch (Throwable e) {}
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (noisy != null) {
            try { unregisterReceiver(noisy); } catch (Throwable e) {}
            noisy = null;
        }
        if (sessao != null) {
            sessao.setActive(false);
            sessao.release();
            sessao = null;
        }
        if (vivo == this) vivo = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent i) { return null; }
}
