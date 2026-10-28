/* ==========================================================================
   Sonicyt Extension · youtube-bridge.js
   Audio COMPLETO sin Invidious.

   Fuente primaria : SoundCloud público (widget API + relay con CORS).
                     Solo acepta pistas ALLOW de duración completa.
                     Su stream es HLS: se usa únicamente si el navegador
                     puede reproducirlo (Safari/iOS).
   Fuente de apoyo : Audius (MP3 progresivo real, CORS abierto).
                     Necesaria en Chrome Android, que no reproduce HLS
                     dentro de un <audio>.

   Registro: window.SonicytExtensions['youtube']
     - capacidades: ['resolve']
     - resolve({ artist, title }, { timeoutMs }) -> Promise<urlAudioCompleto>
     - resolveTrack(...) -> Promise<{ id, title, artist, image, audio, completa }>
     - cancelar() aborta la resolución en curso

   El formato devuelto respeta el contrato del cascarón:
     id, title, artist, image, audio (+ completa)
   ========================================================================== */
(function () {
  'use strict';

  window.SonicytExtensions = window.SonicytExtensions || {};

  // ---- SoundCloud público -------------------------------------------------
  // client_id del reproductor widget oficial (públicos, sin registro de app)
  var SC_CLIENT_IDS = [
    'gqKBMSuBw5rbN9rDRYPqKNvF17ovlObu',
    'nIjtjiYnjkOhMyh5xrbqEW12DxeJVnic'
  ];
  var SC_API = 'https://api-widget.soundcloud.com';
  // Relay CORS: la API del widget solo autoriza orígenes de soundcloud.com.
  // Jina Reader devuelve el JSON con Access-Control-Allow-Origin y sin cookies.
  var RELAY_CORS = 'https://r.jina.ai/';

  // ---- Audius (MP3 completo) ----------------------------------------------
  var AUDIUS_API = 'https://api.audius.co';
  var APP_NAME = 'Sonicyt';

  var TIMEOUT_POR_DEFECTO = 3000;
  // Ventana en la que se espera a SoundCloud antes de usar Audius.
  var VENTANA_PREFERENCIA_MS = 900;
  var controladorActivo = null;
  var hlsSoportado = null;

  function esAborto(err) {
    return !!err && err.name === 'AbortError';
  }

  function cancelar() {
    if (controladorActivo) {
      try { controladorActivo.abort(); } catch (e) { /* ya abortado */ }
      controladorActivo = null;
    }
  }

  function puedeReproducirHls() {
    if (hlsSoportado !== null) return hlsSoportado;
    try {
      var prueba = document.createElement('audio');
      hlsSoportado = !!prueba.canPlayType('application/vnd.apple.mpegurl');
    } catch (e) {
      hlsSoportado = false;
    }
    return hlsSoportado;
  }

  // ---------------------------------------------------------------- utilidades
  function normalizarTexto(valor) {
    return String(valor || '').toLowerCase()
      .replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e').replace(/[íìïî]/g, 'i')
      .replace(/[óòöô]/g, 'o').replace(/[úùüû]/g, 'u').replace(/ñ/g, 'n')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function nombreArtista(pista) {
    if (!pista || !pista.user) return '';
    return pista.user.name || pista.user.username || '';
  }

  // Puntúa la coincidencia título/artista para elegir el resultado más fiel
  function puntuar(pista, artista, titulo) {
    var objetivo = normalizarTexto(artista + ' ' + titulo);
    var texto = normalizarTexto((pista.title || '') + ' ' + nombreArtista(pista));
    var palabras = objetivo.split(' ').filter(function (w) { return w.length > 2; });
    if (!palabras.length) return 0;
    var aciertos = 0;
    for (var i = 0; i < palabras.length; i++) {
      if (texto.indexOf(palabras[i]) !== -1) aciertos += 1;
    }
    return aciertos / palabras.length;
  }

  function elegirMejor(lista, artista, titulo) {
    var mejor = lista[0];
    var mejorPuntos = -1;
    for (var i = 0; i < lista.length; i++) {
      var puntos = puntuar(lista[i], artista, titulo);
      if (puntos > mejorPuntos) {
        mejorPuntos = puntos;
        mejor = lista[i];
      }
    }
    return mejor;
  }

  // SoundCloud es la fuente preferida, pero su resolución encadena dos relés
  // (búsqueda + transcoding) y tarda más que Audius, que responde en una sola
  // petición. Si compitieran en igualdad, Audius ganaría siempre y SoundCloud
  // quedaría muerto. Por eso se le da una ventana de preferencia corta:
  //   - SoundCloud gana si responde dentro de esa ventana.
  //   - Audius se usa en cuanto la ventana expira o SoundCloud falla.
  function resolverConPreferencia(promesaPreferida, promesaRespaldo, graciaMs) {
    return new Promise(function (resolve, reject) {
      var decidido = false;
      var graciaAgotada = false;
      var preferidaTerminada = false;
      var fallos = 0;
      var respaldo = null; // { valor: ... } | { error: ... }

      function terminar(valor, error) {
        if (decidido) return;
        decidido = true;
        clearTimeout(temporizador);
        if (valor) { resolve(valor); return; }
        if (esAborto(error)) { reject(error); return; }
        reject(new Error('Ninguna fuente devolvió audio completo' +
          (fallos ? ' (' + fallos + ' fallos)' : '')));
      }

      function usarRespaldo() {
        if (!respaldo) return;
        if (respaldo.valor) terminar(respaldo.valor);
        else terminar(null, respaldo.error);
      }

      var temporizador = setTimeout(function () {
        graciaAgotada = true;
        usarRespaldo();
      }, graciaMs);

      promesaPreferida.then(function (valor) {
        preferidaTerminada = true;
        if (valor) terminar(valor);
        else { fallos += 1; usarRespaldo(); }
      }, function (err) {
        preferidaTerminada = true;
        if (esAborto(err)) terminar(null, err);
        else { fallos += 1; usarRespaldo(); }
      });

      promesaRespaldo.then(function (valor) {
        respaldo = { valor: valor };
        if (!valor) fallos += 1;
        // Si la preferida ya terminó sin resultado, no se espera la ventana
        if (graciaAgotada || preferidaTerminada) usarRespaldo();
      }, function (err) {
        respaldo = { error: err };
        fallos += 1;
        if (graciaAgotada || preferidaTerminada) usarRespaldo();
      });
    });
  }

  // ------------------------------------------------------- SoundCloud (relay)
  function leerJsonRelay(urlDestino, signal) {
    return fetch(RELAY_CORS + urlDestino, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Accept': 'text/plain' },
      signal: signal
    }).then(function (res) {
      if (!res.ok) throw new Error('Relay HTTP ' + res.status);
      return res.text();
    }).then(function (texto) {
      var marca = 'Markdown Content:';
      var corte = texto.indexOf(marca);
      var crudo = (corte === -1) ? texto : texto.slice(corte + marca.length);
      var inicio = crudo.indexOf('{');
      if (inicio === -1) throw new Error('Relay sin JSON');
      try {
        return JSON.parse(crudo.slice(inicio));
      } catch (e) {
        throw new Error('Relay JSON inválido');
      }
    });
  }

  // Solo pistas ALLOW completas: descarta SNIP/MONETIZE (30 s) y previews
  function filtrarSoundCloud(coleccion) {
    var salida = [];
    var lista = coleccion || [];
    for (var i = 0; i < lista.length; i++) {
      var t = lista[i];
      if (!t || !t.streamable || t.policy !== 'ALLOW') continue;
      var total = t.full_duration || t.duration || 0;
      if (!t.duration || total <= 0) continue;
      if (t.duration < total * 0.98) continue;
      var transcodings = (t.media && t.media.transcodings) || [];
      if (!transcodings.length) continue;
      salida.push(t);
    }
    return salida;
  }

  function streamSoundCloud(pista, clientId, signal) {
    var transcodings = (pista.media && pista.media.transcodings) || [];
    var elegido = null;

    for (var i = 0; i < transcodings.length; i++) {
      var tr = transcodings[i];
      if (tr.format && tr.format.protocol === 'progressive') { elegido = tr; break; }
    }
    if (!elegido) elegido = transcodings[0];
    if (!elegido) return Promise.resolve(null);

    var sep = elegido.url.indexOf('?') === -1 ? '?' : '&';
    return leerJsonRelay(elegido.url + sep + 'client_id=' + clientId, signal)
      .then(function (datos) {
        var url = datos && datos.url;
        if (!url) return null;

        var hls = (elegido.format && elegido.format.protocol === 'hls') ||
          url.indexOf('.m3u8') !== -1;

        // Chrome Android no reproduce HLS en <audio>: se descarta
        if (hls && !puedeReproducirHls()) return null;

        return {
          id: 'sc-' + pista.id,
          title: pista.title || '',
          artist: nombreArtista(pista),
          image: pista.artwork_url || (pista.user && pista.user.avatar_url) || '',
          audio: url,
          completa: true,
          fuente: 'soundcloud',
          hls: hls
        };
      });
  }

  function buscarSoundCloud(consulta, artista, titulo, signal) {
    var indice = 0;

    function intentar() {
      if (indice >= SC_CLIENT_IDS.length) return Promise.resolve(null);
      var clientId = SC_CLIENT_IDS[indice];
      indice += 1;

      var url = SC_API + '/search/tracks?q=' + encodeURIComponent(consulta) +
        '&limit=8&client_id=' + clientId;

      return leerJsonRelay(url, signal).then(function (datos) {
        var pistas = filtrarSoundCloud(datos && datos.collection);
        if (!pistas.length) return intentar();
        return streamSoundCloud(elegirMejor(pistas, artista, titulo), clientId, signal)
          .then(function (resultado) {
            if (resultado) return resultado;
            return intentar();
          });
      }).catch(function (err) {
        if (esAborto(err)) throw err;
        return intentar();
      });
    }

    return intentar();
  }

  // -------------------------------------------------------- Audius (MP3 real)
  function buscarAudius(consulta, artista, titulo, signal) {
    var url = AUDIUS_API + '/v1/tracks/search?query=' + encodeURIComponent(consulta) +
      '&app_name=' + encodeURIComponent(APP_NAME) + '&limit=10';

    return fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Accept': 'application/json' },
      signal: signal
    }).then(function (res) {
      if (!res.ok) throw new Error('Audius HTTP ' + res.status);
      return res.json();
    }).then(function (datos) {
      var lista = (datos && datos.data) || [];
      var validas = [];

      for (var i = 0; i < lista.length; i++) {
        var t = lista[i];
        if (!t || !t.track_id || t.is_streamable === false) continue;
        validas.push(t);
      }
      if (!validas.length) return null;

      var mejor = elegirMejor(validas, artista, titulo);
      if (!mejor) return null;

      var arte = '';
      if (mejor.artwork) {
        arte = mejor.artwork['480x480'] || mejor.artwork['150x150'] || '';
      }

      return {
        id: 'aud-' + mejor.track_id,
        title: mejor.title || '',
        artist: nombreArtista(mejor),
        image: arte,
        audio: AUDIUS_API + '/v1/tracks/' + mejor.track_id + '/stream?app_name=' + encodeURIComponent(APP_NAME),
        completa: true,
        fuente: 'audius'
      };
    });
  }

  // ------------------------------------------------------------- resolución
  function resolverTrack(pista, opciones) {
    var opts = opciones || {};
    var timeoutMs = opts.timeoutMs || TIMEOUT_POR_DEFECTO;
    var datos = pista || {};
    var artista = datos.artist || '';
    var titulo = datos.title || '';
    var consulta = (artista + ' ' + titulo).trim() || String(datos.consulta || '').trim();

    if (!consulta) {
      return Promise.reject(new Error('Pista sin artista/título para buscar audio completo'));
    }

    cancelar();
    var controlador = new AbortController();
    controladorActivo = controlador;

    var timer = setTimeout(function () { controlador.abort(); }, timeoutMs);
    var internos = [];

    function senal() {
      var c = new AbortController();
      internos.push(c);
      if (controlador.signal.aborted) {
        try { c.abort(); } catch (e) { /* ya abortado */ }
      } else {
        controlador.signal.addEventListener('abort', function () {
          try { c.abort(); } catch (e) { /* ya abortado */ }
        });
      }
      return c.signal;
    }

    // SoundCloud tiene prioridad; Audius cubre el hueco con su MP3 real
    var ventanaPreferencia = Math.min(VENTANA_PREFERENCIA_MS, Math.max(150, Math.floor(timeoutMs / 2)));
    var fuentes = resolverConPreferencia(
      buscarSoundCloud(consulta, artista, titulo, senal()),
      buscarAudius(consulta, artista, titulo, senal()),
      ventanaPreferencia
    );

    function limpiar() {
      clearTimeout(timer);
      for (var i = 0; i < internos.length; i++) {
        try { internos[i].abort(); } catch (e) { /* ya abortado */ }
      }
      if (controladorActivo === controlador) controladorActivo = null;
    }

    return fuentes.then(
      function (resultado) {
        limpiar();
        return resultado;
      },
      function (err) {
        limpiar();
        throw err;
      }
    );
  }

  function resolver(pista, opciones) {
    return resolverTrack(pista, opciones).then(function (resultado) {
      return resultado.audio;
    });
  }

  window.SonicytExtensions['youtube'] = {
    id: 'youtube',
    nombre: 'SoundCloud Bridge',
    version: '2.0.0',
    tipo: 'audio-completo',
    orden: 20,
    capacidades: ['resolve'],
    proveedores: ['soundcloud', 'audius'],
    timeoutPorDefecto: TIMEOUT_POR_DEFECTO,
    ventanaPreferenciaMs: VENTANA_PREFERENCIA_MS,
    clientIdsSoundCloud: SC_CLIENT_IDS,
    relayCors: RELAY_CORS,
    puedeReproducirHls: puedeReproducirHls,
    cancelar: cancelar,
    resolveTrack: resolverTrack,
    resolve: resolver
  };
})();
