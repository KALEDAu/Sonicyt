/* ==========================================================================
   Sonicyt Extension · youtube-bridge.js
   Conector de AUDIO COMPLETO (itag 141/140 m4a) vía Invidious.
   Estrategia AGRESIVA: no espera turnos. Dispara en paralelo todas las
   instancias + sus variantes proxificadas (allorigins / codetabs) y se
   queda con la primera respuesta JSON válida. Sin cookies: credentials omit.

   Registro: window.SonicytExtensions['youtube']
     - capacidades: ['resolve']
     - resolve({ artist, title }, { timeoutMs }) -> Promise<urlMp3Completo>
     - cancelar() aborta la resolución en curso
   ========================================================================== */
(function () {
  'use strict';

  window.SonicytExtensions = window.SonicytExtensions || {};

  var SERVIDORES_INVIDIOUS = [
    'https://tux.digital',
    'https://projectsegfau.lt',
    'https://yewtu.be'
  ];

  // Proxies CORS acoplados DENTRO de la extensión (el cascarón no los conoce).
  // "raw" devuelve el cuerpo tal cual; se codifica la URL destino completa.
  var PROXIES_CORS = [
    'https://api.allorigins.win/raw?url=',
    'https://api.codetabs.com/v1/proxy?quest='
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

  // Cada URL directa se multiplica por los proxies disponibles
  function candidatosPara(urlDirecta) {
    var lista = [urlDirecta];
    for (var p = 0; p < PROXIES_CORS.length; p++) {
      lista.push(PROXIES_CORS[p] + encodeURIComponent(urlDirecta));
    }
    return lista;
  }

  // Fetch sin cookies ni caché; tolera content-type mentiroso del proxy
  function pedirJson(url, signal) {
    return fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Accept': 'application/json' },
      signal: signal
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (texto) {
      try {
        return JSON.parse(texto);
      } catch (e) {
        throw new Error('Respuesta no JSON');
      }
    });
  }

  // Carrera real: primera respuesta válida gana; el resto se ignora
  function carreraCandidatos(urls, validar, signal) {
    return new Promise(function (resolve, reject) {
      var pendientes = urls.length;
      var errores = [];
      var terminado = false;

      if (pendientes === 0) {
        reject(new Error('Sin candidatos disponibles'));
        return;
      }

      urls.forEach(function (url) {
        pedirJson(url, signal).then(function (data) {
          var valido = validar(data);
          if (!valido) throw new Error('Respuesta sin datos útiles');
          if (!terminado) {
            terminado = true;
            resolve(valido);
          }
        }).catch(function (err) {
          if (esAborto(err)) {
            if (!terminado) {
              terminado = true;
              reject(err);
            }
            return;
          }
          errores.push(err.message);
          pendientes -= 1;
          if (pendientes === 0 && !terminado) {
            terminado = true;
            reject(new Error('Todos los candidatos fallaron (' + errores.length + ' intentos)'));
          }
        });
      });
    });
  }

  // Paso 1: artista + título → videoId (carrera de instancias y proxies)
  function buscarVideoId(consulta, signal) {
    var candidatos = [];
    for (var i = 0; i < SERVIDORES_INVIDIOUS.length; i++) {
      var url = SERVIDORES_INVIDIOUS[i] + '/api/v1/search?q=' +
        encodeURIComponent(consulta) + '&type=video&sort_by=relevance';
      candidatos = candidatos.concat(candidatosPara(url));
    }

    return carreraCandidatos(candidatos, function (data) {
      if (Array.isArray(data) && data.length > 0 && data[0].videoId) {
        return data[0].videoId;
      }
      return null;
    }, signal);
  }

  // Paso 2: videoId → stream de audio (prioriza m4a de mayor calidad)
  function extraerAudio(videoId, signal) {
    var candidatos = [];
    for (var i = 0; i < SERVIDORES_INVIDIOUS.length; i++) {
      var url = SERVIDORES_INVIDIOUS[i] + '/api/v1/videos/' + encodeURIComponent(videoId);
      candidatos = candidatos.concat(candidatosPara(url));
    }

    return carreraCandidatos(candidatos, function (video) {
      if (!video || !Array.isArray(video.adaptiveFormats)) return null;

      var formatos = video.adaptiveFormats;
      var itag141 = null;
      var itag140 = null;
      var mp4 = null;
      var generico = null;

      for (var f = 0; f < formatos.length; f++) {
        var item = formatos[f];
        if (!item || !item.url) continue;
        var tipo = item.contentType || '';

        if (item.itag === 141) { if (!itag141) itag141 = item; continue; }
        if (item.itag === 140) { if (!itag140) itag140 = item; continue; }
        if (tipo.indexOf('audio/mp4') === 0) {
          if (!mp4 || (item.bitrate || 0) > (mp4.bitrate || 0)) mp4 = item;
          continue;
        }
        if (tipo.indexOf('audio/') === 0) {
          if (!generico || (item.bitrate || 0) > (generico.bitrate || 0)) generico = item;
        }
      }

      var elegido = itag141 || itag140 || mp4 || generico;
      if (!elegido) return null;

      var miniatura = '';
      if (video.videoThumbnails && video.videoThumbnails.length) {
        miniatura = video.videoThumbnails[0].url || '';
      }

      return {
        url: elegido.url,
        itag: elegido.itag,
        tipo: elegido.contentType || '',
        bitrate: elegido.bitrate || 0,
        titulo: video.title || '',
        autor: video.author || '',
        miniatura: miniatura
      };
    }, signal);
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
    version: '1.1.0',
    tipo: 'audio-completo',
    orden: 20,
    capacidades: ['resolve'],
    servidores: SERVIDORES_INVIDIOUS,
    proxies: PROXIES_CORS,
    timeoutPorDefecto: TIMEOUT_POR_DEFECTO,
    candidatosPara: candidatosPara,
    pedirJson: pedirJson,
    buscarVideoId: buscarVideoId,
    extraerAudio: extraerAudio,
    cancelar: cancelar,
    resolve: resolver
  };
})();
