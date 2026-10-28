/* ========================================
   Mi Música — Lógica PWA (Vanilla JS)
   Búsqueda Invidious + extracción audio itag=140
   ======================================== */

const INVIDIOUS = 'https://invidious.nerdvpn.de'; // instancia pública (cámbiala si cae)

// ---------- Elementos DOM ----------
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const resultsEl = document.getElementById('results');
const emptyEl = document.getElementById('emptyState');

const audio = new Audio();
audio.preload = 'none';

let currentSong = null;

// Barra de reproductor
const playerBar = document.getElementById('playerBar');
const playerThumb = document.getElementById('playerThumb');
const playerTitle = document.getElementById('playerTitle');
const playerArtist = document.getElementById('playerArtist');
const btnPlayPause = document.getElementById('btnPlayPause');
const progressBar = document.getElementById('progressBar');
const timeCurrent = document.getElementById('timeCurrent');
const timeDuration = document.getElementById('timeDuration');

function fmtTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function escapeHtml(text) {
  if (!text) return '';
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ---------- Búsqueda en Invidious ----------
async function buscar(q) {
  try {
    emptyEl.textContent = 'Buscando…';
    emptyEl.style.display = 'block';
    resultsEl.innerHTML = '';

    const url = INVIDIOUS + '/api/v1/search?q=' + encodeURIComponent(q) + '&type=video';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Respuesta de API: ' + res.status);

    const data = await res.json();
    renderizar(data || []);
  } catch (err) {
    console.error(err);
    resultsEl.innerHTML = '';
    emptyEl.textContent = 'No se pudo conectar con Invidious. Revisa tu conexión o prueba otra instancia.';
    emptyEl.style.display = 'block';
  }
}

function renderizar(items) {
  resultsEl.innerHTML = '';
  if (!items || items.length === 0) {
    emptyEl.textContent = 'No se encontraron resultados';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  items.forEach(function (it) {
    const thumbUrl = (it.thumbnails && it.thumbnails[0] && it.thumbnails[0].url)
      ? it.thumbnails[0].url
      : 'https://via.placeholder.com/320x180.png?text=Audio';

    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML =
      '<div class="thumb"><img src="' + escapeHtml(thumbUrl) + '" alt=""></div>' +
      '<div class="info">' +
      '<div class="title">' + escapeHtml(it.title) + '</div>' +
      '<div class="artist">' + escapeHtml(it.author) + '</div>' +
      '</div>';

    card.onclick = function () {
      cargarCancion(it);
    };

    resultsEl.appendChild(card);
  });
}

// ---------- Cargar canción y extraer audio directo ----------
async function cargarCancion(item) {
  try {
    const res = await fetch(INVIDIOUS + '/api/v1/videos/' + item.videoId);
    if (!res.ok) throw new Error('No se pudo obtener la información del video');
    const vid = await res.json();

    let audioUrl = null;
    const formats = vid.adaptiveFormats || [];

    // Priorizar itag 140 (audio mp4) o cualquier stream solo de audio
    const f = formats.find(function (x) {
      return x.itag === 140 || (x.contentType && x.contentType.startsWith('audio/'));
    });

    if (f && f.url) {
      audioUrl = f.url;
    } else {
      const fs = vid.formatStreams || [];
      const f2 = fs.find(function (x) {
        return x.itag === 140 || (x.type && x.type.includes('audio'));
      });
      if (f2 && f2.url) audioUrl = f2.url;
    }

    if (!audioUrl) throw new Error('No se encontró stream de audio directo (itag=140)');

    currentSong = {
      id: vid.videoId || item.videoId,
      title: vid.title || item.title,
      artist: vid.author || item.author,
      thumb: (vid.thumbnails && vid.thumbnails[0] && vid.thumbnails[0].url)
        ? vid.thumbnails[0].url
        : (item.thumbnails && item.thumbnails[0] ? item.thumbnails[0].url : ''),
      url: audioUrl
    };

    audio.src = currentSong.url;
    await audio.play().catch(function () {
      // Autoplay bloqueado; el usuario pulsará play
    });

    actualizarInterfazReproductor();
  } catch (err) {
    console.error(err);
    alert('No se pudo reproducir la canción:\n' + err.message);
  }
}

function actualizarInterfazReproductor() {
  if (!currentSong) return;
  playerBar.style.display = 'flex';
  playerThumb.src = currentSong.thumb;
  playerTitle.textContent = currentSong.title;
  playerArtist.textContent = currentSong.artist;
  btnPlayPause.textContent = audio.paused ? '▶' : '⏸';
}

// ---------- Controles ----------
btnPlayPause.onclick = function () {
  if (!currentSong) return;
  if (audio.paused) {
    audio.play().catch(function () {});
  } else {
    audio.pause();
  }
};

audio.onplay = function () {
  btnPlayPause.textContent = '⏸';
};

audio.onpause = function () {
  btnPlayPause.textContent = '▶';
};

audio.onended = function () {
  btnPlayPause.textContent = '▶';
};

audio.ontimeupdate = function () {
  if (audio.duration) {
    progressBar.max = audio.duration;
    progressBar.value = audio.currentTime;
  }
  timeCurrent.textContent = fmtTime(audio.currentTime);
  timeDuration.textContent = fmtTime(audio.duration);
};

progressBar.oninput = function () {
  if (audio.duration) {
    audio.currentTime = progressBar.value;
  }
};

// ---------- Registro Service Worker (PWA offline) ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(function (reg) {
    console.log('SW registrado:', reg.scope);
  }).catch(function (err) {
    console.error('Error al registrar SW:', err);
  });
}

// ---------- Eventos de búsqueda ----------
searchBtn.onclick = function () {
  const q = searchInput.value.trim();
  if (q) buscar(q);
};

searchInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q) buscar(q);
  }
});
