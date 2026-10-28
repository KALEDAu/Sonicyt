/* ==========================================================================
   Sonicyt Extension · youtube-bridge.js
   Audio completo sin Invidious.

   Técnica portada de la extensión SoundCloud de SpotiFLAC (Mornye 5.0.5):
     - client_id se descubre dinámicamente desde el HTML de soundcloud.com
       y se refresca solo (401) con caducidad de 24 h.
     - Se usa api-v2 (no el widget) y se exige track_authorization al pedir
       el stream: sin él SoundCloud devuelve 401/404.
     - Solo se aceptan transcodings NO recortados (snipped=false) cuya
       duración coincida con la pista completa; se descartan los previews
       SNIP/MONETIZE de 30 s.
     - Se puntúa la coincidencia título/artista antes de elegir resultado.

   Diferencias adaptadas a la PWA:
     - El navegador no puede leer soundcloud.com por CORS: se usa el relay
       r.jina.ai (JSON con X-Return-Format: text, HTML con html).
     - SoundCloud ya no sirve MP3 progresivo: entrega HLS. El CDN
       (playlist, init y segmentos) sí abre CORS *, así que el cascarón lo
       reproduce con hls.js (MSE) en Android y de forma nativa en iOS.
     - Audius sigue como respaldo MP3 cuando SoundCloud bloquea la pista.

   Registro: window.SonicytExtensions['youtube']
     - capacidades: ['resolve']
     - resolve({ artist, title }, { timeoutMs }) -> Promise<urlAudioCompleto>
     - resolveTrack(...) -> Promise<{ id, title, artist, image, audio, ... }>
     - cancelar() aborta la resolución en curso

   Contrato del cascarón: id, title, artist, image, audio (+ completa).
   ========================================================================== */
(function () {
  'use strict';

  window.SonicytExtensions = window.SonicytExtensions || {};

  // ---- SoundCloud ---------------------------------------------------------
  var SC_API = 'https://api-v2.soundcloud.com';
  var SC_HOME = 'https://soundcloud.com/';
  var SC_CLIENT_KEY = 'sonicyt-sc-client';
  var SC_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
  // IDs públicos del reproductor widget: respaldo si el HTML cambia.
  var SC_CLIENT_IDS_RESPALDO = [
    'gqKBMSuBw5rbN9rDRYPqKNvF17ovlObu',
    'nIjtjiYnjkOhMyh5xrbqEW12DxeJVnic'
  ];

  // Relay CORS: la API de SoundCloud no autoriza kaledau.github.io.
  var RELAY_CORS = 'https://r.jina.ai/';

  // ---- Audius (MP3 completo) ----------------------------------------------
  var AUDIUS_API = 'https://api.audius.co';
  var APP_NAME = 'Sonicyt';

  var TIMEOUT_POR_DEFECTO = 10000;
  var VENTANA_PREFERENCIA_MS = 4500;
  var CACHE_TTL_MS = 5 * 60 * 1000;
  var CACHE_MAX = 120;

  var controladorActivo = null;
  var cachePistas = new Map();
  var hlsNativo = null;
  var mseSoportado = null;

  function esAborto(err) {
    return !!err && err.name === 'AbortError';
  }

  function cancelar() {
    if (controladorActivo) {
      try { controladorActivo.abort(); } catch (e) { /* ya abortado */ }
      controladorActivo = null;
    }
  }

  // ----------------------------------------------------------- capacidades
  function puedeReproducirHlsNativo() {
    if (hlsNativo !== null) return hlsNativo;
    try {
      var prueba = document.createElement('audio');
      hlsNativo = !!prueba.canPlayType('application/vnd.apple.mpegurl');
    } catch (e) {
      hlsNativo = false;
    }
    return hlsNativo;
  }

  function puedeUsarMse() {
    if (mseSoportado !== null) return mseSoportado;
    try {
      mseSoportado = typeof window.MediaSource !== 'undefined' ||
        typeof window.ManagedMediaSource !== 'undefined';
    } catch (e) {
      mseSoportado = false;
    }
    return mseSoportado;
  }

  // HLS reproducible = nativo (iOS) o vía hls.js/MSE (Chrome Android)
  function puedeReproducirHls() {
    return puedeReproducirHlsNativo() || puedeUsarMse();
  }

  // ------------------------------------------------------------ utilidades
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

  // Portada a resolución alta (misma idea que hiResArtwork de Mornye)
  function portadaGrande(url) {
    if (!url) return '';
    return String(url).replace('-large.', '-t500x500.');
  }

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
    var mejor = null;
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

  // Caché acotada de pistas ya resueltas (URLs caducan, TTL corto)
  function cacheGet(clave) {
    var entrada = cachePistas.get(clave);
    if (!entrada) return null;
    if (Date.now() >= entrada.expira) {
      cachePistas.delete(clave);
      return null;
    }
    cachePistas.delete(clave);
    cachePistas.set(clave, entrada);
    return entrada.valor;
  }

  function cacheSet(clave, valor) {
    if (!clave || !valor) return valor;
    if (cachePistas.has(clave)) cachePistas.delete(clave);
    cachePistas.set(clave, { valor: valor, expira: Date.now() + CACHE_TTL_MS });
    while (cachePistas.size > CACHE_MAX) {
      cachePistas.delete(cachePistas.keys().next().value);
    }
    return valor;
  }

  // --------------------------------------------------------- relay con CORS
  function pedirRelay(urlDestino, formato, signal) {
    var cabeceras = { 'X-Return-Format': formato || 'text' };
    if (formato === 'html') cabeceras['X-No-Cache'] = 'true';

    return fetch(RELAY_CORS + urlDestino, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: cabeceras,
      signal: signal
    }).then(function (res) {
      if (!res.ok) throw new Error('Relay HTTP ' + res.status);
      return res.text();
    });
  }

  function leerJsonRelay(urlDestino, signal) {
    return pedirRelay(urlDestino, 'text', signal).then(function (texto) {
      return parsearJson(texto);
    });
  }

  function parsearJson(texto) {
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
  }

  // ----------------------------------------------------- client_id dinámico
  function leerEstadoCliente() {
    try {
      var crudo = localStorage.getItem(SC_CLIENT_KEY);
      if (!crudo) return null;
      var datos = JSON.parse(crudo);
      if (!datos || !datos.clientId || !datos.expira) return null;
      if (Date.now() >= datos.expira) return null;
      return datos;
    } catch (e) {
      return null;
    }
  }

  function guardarEstadoCliente(clientId, version) {
    try {
      localStorage.setItem(SC_CLIENT_KEY, JSON.stringify({
        clientId: clientId,
        version: version || '',
        expira: Date.now() + SC_CLIENT_TTL_MS
      }));
    } catch (e) { /* modo privado o sin storage */ }
  }

  function olvidarEstadoCliente() {
    try { localStorage.removeItem(SC_CLIENT_KEY); } catch (e) { /* nada */ }
  }

  // Misma extracción que fetchClientId() de Mornye, sobre el HTML del relay
  function extraerClientIdDeHtml(html) {
    var texto = String(html || '');
    var version = '';
    var ver = texto.match(/__sc_version="(\d{10})"/);
    if (ver) version = ver[1];

    var directo = texto.match(/client_id=([a-zA-Z0-9]{32})/);
    if (!directo) directo = texto.match(/client_id["':=\s]+["']([a-zA-Z0-9]{32})["']/);
    if (directo) return { clientId: directo[1], version: version };
    return null;
  }

  var indiceRespaldo = 0;

  function clienteDeRespaldo() {
    var id = SC_CLIENT_IDS_RESPALDO[indiceRespaldo % SC_CLIENT_IDS_RESPALDO.length];
    indiceRespaldo += 1;
    return id;
  }

  function descubrirClientId(signal) {
    return pedirRelay(SC_HOME, 'html', signal).then(function (html) {
      var hallado = extraerClientIdDeHtml(html);
      if (!hallado) throw new Error('client_id no encontrado en el HTML');
      guardarEstadoCliente(hallado.clientId, hallado.version);
      return hallado.clientId;
    }).catch(function (err) {
      if (esAborto(err)) throw err;
      return null;
    });
  }

  // Devuelve un client_id sin bloquear:
  //   - si hay uno guardado, se usa
  //   - si no, se usa un respaldo válido al instante y se descubre el real
  //     en segundo plano para las próximas peticiones
  //   - con forzar=true (tras un 401) sí se espera al descubrimiento
  function asegurarClientId(signal, forzar) {
    if (!forzar) {
      var estado = leerEstadoCliente();
      if (estado && estado.clientId) return Promise.resolve(estado.clientId);

      var id = clienteDeRespaldo();
      descubrirClientId(null).catch(function () { /* sin red: seguimos con respaldo */ });
      return Promise.resolve(id);
    }

    return descubrirClientId(signal).then(function (id) {
      return id || clienteDeRespaldo();
    });
  }

  // --------------------------------------------------------- API SoundCloud
  function scGet(ruta, extra, signal, reintento) {
    return asegurarClientId(signal, !!reintento).then(function (clientId) {
      var url = SC_API + '/' + ruta +
        (ruta.indexOf('?') === -1 ? '?' : '&') + 'client_id=' + clientId +
        (extra ? '&' + extra : '');

      return leerJsonRelay(url, signal).catch(function (err) {
        // 401: el client_id caducó. Se olvida, se redescubre y se reintenta 1 vez.
        if (!reintento && String(err && err.message).indexOf('HTTP 401') !== -1) {
          olvidarEstadoCliente();
          return scGet(ruta, extra, signal, true);
        }
        throw err;
      });
    });
  }

  // --------------------------------------------------- elección de stream SC
  function filtrarSoundCloud(coleccion) {
    var salida = [];
    var lista = coleccion || [];
    for (var i = 0; i < lista.length; i++) {
      var t = lista[i];
      if (!t || !t.id || !t.streamable) continue;
      if (t.policy === 'BLOCK') continue;
      if (!t.track_authorization) continue;
      var total = t.full_duration || t.duration || 0;
      if (!total) continue;
      if (t.duration && t.duration < total * 0.98) continue; // preview de 30 s
      salida.push(t);
    }
    return salida;
  }

  // Reglas de pickTranscoding de Mornye + puerta HLS de la PWA:
  //   - nunca un transcoding recortado (snipped)
  //   - su duración debe cubrir la pista completa
  //   - progresivo siempre; HLS solo si el navegador puede reproducirlo
  //   - fuera HLS cifrado (cbc/ctr) y con preferencia baja los adaptativos
  //     "abr", que SoundCloud devuelve 404 al pedir su URL.
  function candidatosTranscoding(pista, conHls) {
    var transcodings = (pista && pista.media && pista.media.transcodings) || [];
    var total = (pista && (pista.full_duration || pista.duration)) || 0;
    var lista = [];

    for (var i = 0; i < transcodings.length; i++) {
      var tr = transcodings[i];
      if (!tr || !tr.url || !tr.format) continue;
      if (tr.snipped) continue;
      if (tr.duration && total && tr.duration < total * 0.98) continue;

      var protocolo = tr.format.protocol || '';
      var mime = tr.format.mime_type || '';
      var esHls = protocolo === 'hls' || mime.indexOf('mpegurl') !== -1;
      var esProgresivo = protocolo === 'progressive';

      if (protocolo.indexOf('encrypted') !== -1) continue;
      if (esHls && !conHls) continue;
      if (!esHls && !esProgresivo) continue;

      var puntos = esProgresivo ? 60 : 40;
      if (mime.indexOf('mpeg') !== -1 || mime.indexOf('mp3') !== -1) puntos += 8;
      if (tr.quality === 'hq') puntos += 6;
      else if (tr.quality === 'sq') puntos += 3;
      if (tr.preset === 'aac_96k' || tr.preset === 'aac_160k') puntos += 4;
      if (String(tr.preset || '').indexOf('abr') === 0) puntos -= 25;

      lista.push({ transcoding: tr, hls: esHls, puntos: puntos });
    }

    lista.sort(function (a, b) { return b.puntos - a.puntos; });
    return lista;
  }

  function elegirTranscoding(pista, conHls) {
    var lista = candidatosTranscoding(pista, conHls);
    return lista.length ? lista[0] : null;
  }

  function resolverStreamSoundCloud(pista, clientId, conHls, signal) {
    var candidatos = candidatosTranscoding(pista, conHls);
    if (!candidatos.length) return Promise.resolve(null);

    // Se prueban en orden: algunos presets (abr_*) devuelven 404 sin url.
    var indice = 0;

    function intentar() {
      if (indice >= candidatos.length || indice >= 3) return Promise.resolve(null);
      var eleccion = candidatos[indice];
      indice += 1;

      var tr = eleccion.transcoding;
      var sep = tr.url.indexOf('?') === -1 ? '?' : '&';
      var url = tr.url + sep + 'client_id=' + clientId +
        '&track_authorization=' + encodeURIComponent(pista.track_authorization);

      return leerJsonRelay(url, signal).then(function (datos) {
        if (!datos || !datos.url) return intentar();
        return {
          id: 'sc-' + pista.id,
          title: pista.title || '',
          artist: nombreArtista(pista),
          image: portadaGrande(pista.artwork_url || (pista.user && pista.user.avatar_url)),
          audio: datos.url,
          completa: true,
          fuente: 'soundcloud',
          hls: eleccion.hls,
          hlsNativo: eleccion.hls ? puedeReproducirHlsNativo() : false
        };
      }).catch(function (err) {
        if (esAborto(err)) throw err;
        return intentar();
      });
    }

    return intentar();
  }

  var cacheCliente = null;

  function buscarSoundCloud(consulta, artista, titulo, signal) {
    var clave = 'sc:' + normalizarTexto(consulta);
    var cacheado = cacheGet(clave);
    if (cacheado) return Promise.resolve(cacheado);

    var url = '/search/tracks?q=' + encodeURIComponent(consulta) + '&limit=20';

    return scGet(url, '', signal, false).then(function (datos) {
      var pistas = filtrarSoundCloud(datos && datos.collection);
      if (!pistas.length) return null;

      var mejor = elegirMejor(pistas, artista, titulo);
      if (!mejor) return null;

      return asegurarClientId(signal).then(function (clientId) {
        cacheCliente = clientId;
        return resolverStreamSoundCloud(mejor, clientId, puedeReproducirHls(), signal);
      }).then(function (resultado) {
        if (resultado) cacheSet(clave, resultado);
        return resultado;
      });
    });
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
        if (!t || !t.track_id) continue;
        if (t.is_streamable === false) continue;
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
        audio: AUDIUS_API + '/v1/tracks/' + mejor.track_id + '/stream?app_name=' +
          encodeURIComponent(APP_NAME),
        completa: true,
        fuente: 'audius',
        hls: false,
        hlsNativo: false
      };
    });
  }

  // ------------------------------------------------------------- resolución
  // SoundCloud manda, pero encadena dos relés. Audius responde en una sola
  // petición, así que se le da a SoundCloud una ventana de preferencia.
  function resolverConPreferencia(promesaPreferida, promesaRespaldo, graciaMs) {
    return new Promise(function (resolve, reject) {
      var decidido = false;
      var graciaAgotada = false;
      var preferidaTerminada = false;
      var fallos = 0;
      var respaldo = null;

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
        if (graciaAgotada || preferidaTerminada) usarRespaldo();
      }, function (err) {
        respaldo = { error: err };
        fallos += 1;
        if (graciaAgotada || preferidaTerminada) usarRespaldo();
      });
    });
  }

  function resolverTrack(pista, opciones) {
    var opts = opciones || {};
    var timeoutMs = opts.timeoutMs || TIMEOUT_POR_DEFECTO;
    var datos = pista || {};
    var artista = datos.artist || datos.artist_name || '';
    var titulo = datos.title || datos.name || '';
    var consulta = (artista + ' ' + titulo).trim() ||
      String(datos.consulta || '').trim();

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

    var ventana = Math.min(VENTANA_PREFERENCIA_MS, Math.max(200, timeoutMs - 800));
    var promesa = resolverConPreferencia(
      buscarSoundCloud(consulta, artista, titulo, senal()),
      buscarAudius(consulta, artista, titulo, senal()),
      ventana
    );

    function limpiar() {
      clearTimeout(timer);
      for (var i = 0; i < internos.length; i++) {
        try { internos[i].abort(); } catch (e) { /* ya abortado */ }
      }
      if (controladorActivo === controlador) controladorActivo = null;
    }

    return promesa.then(
      function (resultado) { limpiar(); return resultado; },
      function (err) { limpiar(); throw err; }
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
    version: '3.1.0',
    tipo: 'audio-completo',
    orden: 20,
    capacidades: ['resolve'],
    proveedores: ['soundcloud', 'audius'],
    timeoutPorDefecto: TIMEOUT_POR_DEFECTO,
    ventanaPreferenciaMs: VENTANA_PREFERENCIA_MS,
    relayCors: RELAY_CORS,
    puedeReproducirHlsNativo: puedeReproducirHlsNativo,
    puedeUsarMse: puedeUsarMse,
    puedeReproducirHls: puedeReproducirHls,
    extraerClientIdDeHtml: extraerClientIdDeHtml,
    filtrarSoundCloud: filtrarSoundCloud,
    candidatosTranscoding: candidatosTranscoding,
    elegirTranscoding: elegirTranscoding,
    portadaGrande: portadaGrande,
    cancelar: cancelar,
    resolveTrack: resolverTrack,
    resolve: resolver
  };
})();
