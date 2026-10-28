/* ==========================================================================
   Sonicyt Extension · youtube-bridge.js
   Conector de AUDIO COMPLETO: resuelve la pista íntegra (itag=140) vía
   Invidious, sin cookies ni claves. Registro: window.SonicytExtensions['youtube']

   Contrato del conector (estilo .sflx):
     - capacidades: ['resolve']
     - resolve({ artist, title }, { timeoutMs }) -> Promise<urlMp3Completo>
     - cancelar() aborta la resolución en curso
   No toca la interfaz: el cascarón decide cuándo hacer el swap del stream.
   ========================================================================== */
(function () {
  'use strict';

  window.SonicytExtensions = window.SonicytExtensions || {};

  var SERVIDORES_INVIDIOUS = [
    'https://tux.digital',
    'https://projectsegfau.lt',
    'https://yewtu.be'
  ];

  var TIMEOUT_POR_DEFECTO = 3000;
  var controladorActivo = null;

  function esAborto(err) {
    return !!err && err.name === 'AbortError';
  }

  function cancelar() {
    if (controladorActivo) {
      try { controladorActivo.abort(); } catch (e) { /* ya abortado */ }
      controladorActivo = null;
    }
  }

  // Paso 1: artista + título → videoId, recorriendo servidores en orden
  function buscarVideoId(consulta, signal) {
    var i = 0;

    function intentar() {
      if (i >= SERVIDORES_INVIDIOUS.length) {
        return Promise.reject(new Error('Invidious: ningún servidor respondió'));
      }
      var base = SERVIDORES_INVIDIOUS[i];
      i += 1;
      var url = base + '/api/v1/search?q=' + encodeURIComponent(consulta) + '&type=video&sort_by=relevance';

      return fetch(url, { mode: 'cors', signal: signal })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status + ' en ' + base);
          return res.json();
        })
        .then(function (data) {
          if (Array.isArray(data) && data.length > 0 && data[0].videoId) {
            return data[0].videoId;
          }
          throw new Error('Sin coincidencias en ' + base);
        })
        .catch(function (err) {
          if (esAborto(err)) throw err;
          return intentar();
        });
    }

    return intentar();
  }

  // Paso 2: videoId → stream de audio itag=140 (m4a, compatible con iPhone)
  function extraerAudio(videoId, signal) {
    var i = 0;

    function intentar() {
      if (i >= SERVIDORES_INVIDIOUS.length) {
        return Promise.reject(new Error('Invidious: sin audio itag=140 disponible'));
      }
      var base = SERVIDORES_INVIDIOUS[i];
      i += 1;

      return fetch(base + '/api/v1/videos/' + encodeURIComponent(videoId), { mode: 'cors', signal: signal })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status + ' en ' + base);
          return res.json();
        })
        .then(function (video) {
          var formatos = (video && video.adaptiveFormats) || [];
          var itag140 = null;
          var mp4 = null;
          var otroAudio = null;

          for (var f = 0; f < formatos.length; f++) {
            var item = formatos[f];
            if (!item || !item.url) continue;
            var tipo = item.contentType || '';
            if (item.itag === 140) { itag140 = item; break; }
            if (!mp4 && tipo.indexOf('audio/mp4') === 0) mp4 = item;
            if (!otroAudio && tipo.indexOf('audio/') === 0) otroAudio = item;
          }

          var elegido = itag140 || mp4 || otroAudio;
          if (!elegido) throw new Error('Formato de audio no disponible en ' + base);

          var miniatura = '';
          if (video && video.videoThumbnails && video.videoThumbnails.length) {
            miniatura = video.videoThumbnails[0].url || '';
          }

          return {
            url: elegido.url,
            itag: elegido.itag,
            titulo: (video && video.title) || '',
            autor: (video && video.author) || '',
            miniatura: miniatura
          };
        })
        .catch(function (err) {
          if (esAborto(err)) throw err;
          return intentar();
        });
    }

    return intentar();
  }

  function resolver(pista, opciones) {
    var opts = opciones || {};
    var timeoutMs = opts.timeoutMs || TIMEOUT_POR_DEFECTO;
    var datos = pista || {};

    var consulta = '';
    if (datos.artist) consulta += datos.artist;
    if (datos.title) consulta += ' ' + datos.title;
    consulta = consulta.trim();
    if (!consulta && datos.consulta) consulta = String(datos.consulta).trim();

    if (!consulta && !datos.videoId) {
      return Promise.reject(new Error('Pista sin artista/título para buscar audio completo'));
    }

    cancelar();
    var controlador = new AbortController();
    controladorActivo = controlador;

    var timer = setTimeout(function () { controlador.abort(); }, timeoutMs);

    function limpiar() {
      clearTimeout(timer);
      if (controladorActivo === controlador) controladorActivo = null;
    }

    var pasos;
    if (datos.videoId) {
      pasos = extraerAudio(datos.videoId, controlador.signal);
    } else {
      pasos = buscarVideoId(consulta, controlador.signal).then(function (videoId) {
        return extraerAudio(videoId, controlador.signal);
      });
    }

    return pasos.then(
      function (audio) {
        limpiar();
        return audio.url;
      },
      function (err) {
        limpiar();
        throw err;
      }
    );
  }

  window.SonicytExtensions['youtube'] = {
    id: 'youtube',
    nombre: 'YouTube Bridge',
    version: '1.0.0',
    tipo: 'audio-completo',
    orden: 20,
    capacidades: ['resolve'],
    servidores: SERVIDORES_INVIDIOUS,
    timeoutPorDefecto: TIMEOUT_POR_DEFECTO,
    buscarVideoId: buscarVideoId,
    extraerAudio: extraerAudio,
    cancelar: cancelar,
    resolve: resolver
  };
})();
