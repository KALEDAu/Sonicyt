/* ==========================================================================
   Sonicyt Extension · itunes-bridge.js
   Conector de catálogo visual (metadatos + portadas de 600 px de Apple).
   Registro: window.SonicytExtensions['itunes']

   Contrato del conector (estilo .sflx):
     - capacidades: ['search']
     - search(consulta, { limit, quality }) -> Promise<pista[]>
     - generos / catalogos: pistas para construir la interfaz
   No conoce el reproductor ni el DOM: solo devuelve datos normalizados.
   ========================================================================== */
(function () {
  'use strict';

  window.SonicytExtensions = window.SonicytExtensions || {};

  var API_BASE = 'https://itunes.apple.com/search?media=music&entity=song&limit=';
  var TAMANOS = { '128': '300x300', '256': '600x600' };
  var TAMANO_POR_DEFECTO = '600x600';

  var GENEROS = [
    'Pop', 'Rock', 'Electronic', 'Lofi', 'Jazz', 'Hip-Hop',
    'Reggaetón', 'Salsa', 'Metal', 'K-Pop', 'Clásica', 'Bossanova'
  ];
  var CATALOGOS = ['Pop', 'Electronic', 'Lofi'];

  function tamanoPortada(quality) {
    if (quality && TAMANOS[quality]) return TAMANOS[quality];
    return TAMANO_POR_DEFECTO;
  }

  // iTunes entrega .../100x100bb.jpg → se amplía al tamaño de la interfaz
  function ampliarPortada(url, quality) {
    if (!url) return '';
    return url.replace(/100x100bb/g, tamanoPortada(quality) + 'bb');
  }

  function normalizar(pista, quality) {
    return {
      id: 'it-' + pista.trackId,
      name: pista.trackName || 'Sin título',
      artist_name: pista.artistName || 'Artista desconocido',
      album: pista.collectionName || '',
      image: ampliarPortada(pista.artworkUrl100, quality),
      audio: pista.previewUrl || null,
      duracion: pista.trackTimeMillis ? Math.round(pista.trackTimeMillis / 1000) : 0,
      completa: false,
      fuente: 'itunes',
      prioridad: 10
    };
  }

  function buscar(consulta, opciones) {
    var opts = opciones || {};
    var termino = (consulta === null || consulta === undefined) ? '' : String(consulta).trim();
    if (!termino) return Promise.resolve([]);

    var limite = opts.limit || 20;
    var quality = opts.quality || '256';
    var url = API_BASE + limite + '&term=' + encodeURIComponent(termino);

    return fetch(url, { mode: 'cors' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' en iTunes');
        return res.json();
      })
      .then(function (data) {
        var resultados = (data && data.results) || [];
        var pistas = [];
        for (var i = 0; i < resultados.length; i++) {
          var r = resultados[i];
          // Sin previewUrl no se puede sonar al instante: se descarta
          if (!r || !r.trackId || !r.previewUrl) continue;
          pistas.push(normalizar(r, quality));
        }
        return pistas;
      });
  }

  window.SonicytExtensions['itunes'] = {
    id: 'itunes',
    nombre: 'Apple iTunes',
    version: '1.0.0',
    tipo: 'catalogo-visual',
    orden: 10,
    capacidades: ['search'],
    generos: GENEROS,
    catalogos: CATALOGOS,
    tamanoPortada: tamanoPortada,
    ampliarPortada: ampliarPortada,
    search: buscar
  };
})();
