/*
 * Reader – liest verschluesselte MangaVault-Exporte (.mvx) auf iPhone und iPad.
 * Nur lesend. Seiten werden erst beim Anzeigen im Arbeitsspeicher entschluesselt;
 * nichts wird hochgeladen. Der Lesefortschritt wird verschluesselt lokal gespeichert.
 */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  const ICON_GRID = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>';
  const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>';
  const IDLE_LOCK_MS = 10 * 60 * 1000;
  const TILES = [92, 132, 180, 250];

  // ------------------------------------------------ Einstellungen (nicht geheim: Ansicht, Richtung, Vorschaugroesse)
  const prefs = (() => {
    const d = { mode: 'page', rtl: true, tile: 1 };
    try { return Object.assign(d, JSON.parse(localStorage.getItem('reader.prefs') || '{}')); } catch (e) { return d; }
  })();
  prefs.tile = clamp(prefs.tile | 0, 0, 3);
  const savePrefs = () => { try { localStorage.setItem('reader.prefs', JSON.stringify(prefs)); } catch (e) { /* privat */ } };

  // ------------------------------------------------ Zustand
  const S = {
    file: null, vault: null, gen: 0,
    folder: null, query: '',
    series: null, chapter: null, page: 0,
    ovChapter: null, ovFrom: null,
    progress: null, resume: null,
  };
  let screen = 'start';
  let lastActivity = Date.now();

  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
    screen = id;
  }

  let toastTimer = 0;
  function toast(msg, warn) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('warn', !!warn);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), warn ? 4200 : 2400);
  }

  // ------------------------------------------------ Hilfsfunktionen
  function limiter(n) {
    let active = 0;
    const q = [];
    const next = () => {
      if (active >= n || !q.length) return;
      active++;
      const job = q.shift();
      Promise.resolve().then(job.fn).then(job.res, job.rej).finally(() => { active--; next(); });
    };
    return (fn, urgent) => new Promise((res, rej) => {
      if (urgent) q.unshift({ fn, res, rej }); else q.push({ fn, res, rej });
      next();
    });
  }
  const pageLimit = limiter(2);
  const thumbLimit = limiter(3);

  function hex(b) { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
  function b64enc(b) {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64dec(s) {
    const bin = atob(s);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  function formatSize(n) {
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
    return (n / 1073741824).toFixed(2).replace('.', ',') + ' GB';
  }
  function clearContainer(c) {
    for (const img of c.querySelectorAll('img')) lazy.unobserve(img);
    c.textContent = '';
  }

  // ------------------------------------------------ Entschluesseln & Bilder
  async function recordBlob(rec) {
    const v = S.vault;
    if (!v) throw new Error('Gesperrt');
    const bytes = await v.readRecord(rec);
    const blob = new Blob([bytes], { type: MVX.imageType(bytes) }); // Blob kopiert die Daten
    bytes.fill(0);
    return blob;
  }

  function loadImg(url) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Bild nicht lesbar'));
      i.src = url;
    });
  }

  /** Verkleinert ein Bild fuer Vorschauen (bleibt im Arbeitsspeicher). */
  async function downscale(blob, width) {
    let src = null, w = 0, h = 0, close = () => {};
    if (window.createImageBitmap) {
      try { const b = await createImageBitmap(blob); src = b; w = b.width; h = b.height; close = () => b.close(); } catch (e) { src = null; }
    }
    if (!src) {
      const url = URL.createObjectURL(blob);
      try { const img = await loadImg(url); src = img; w = img.naturalWidth; h = img.naturalHeight; }
      finally { URL.revokeObjectURL(url); }
    }
    const scale = Math.min(1, width / w);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    close();
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    c.width = c.height = 0;
    if (!out) throw new Error('Vorschau fehlgeschlagen');
    return URL.createObjectURL(out);
  }

  // Vorschaubilder: kleiner LRU-Speicher
  const thumbs = new Map();
  const thumbJobs = new Map();
  const THUMB_MAX = 400;
  function thumb(rec, width, wanted) {
    const key = rec + ':' + width;
    const hit = thumbs.get(key);
    if (hit) { thumbs.delete(key); thumbs.set(key, hit); return Promise.resolve(hit); }
    const running = thumbJobs.get(key);
    if (running) return running;
    const gen = S.gen;
    const job = thumbLimit(async () => {
      if (gen !== S.gen || (wanted && !wanted())) throw new Error('skip');
      const url = await downscale(await recordBlob(rec), width);
      if (gen !== S.gen) { URL.revokeObjectURL(url); throw new Error('skip'); }
      thumbs.set(key, url);
      while (thumbs.size > THUMB_MAX) {
        const [k, u] = thumbs.entries().next().value;
        thumbs.delete(k);
        URL.revokeObjectURL(u);
      }
      return url;
    }).finally(() => thumbJobs.delete(key));
    thumbJobs.set(key, job);
    return job;
  }

  const lazy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const img = e.target;
      img._visible = e.isIntersecting;
      if (e.isIntersecting && !img.classList.contains('ready') && !img._loading) loadThumb(img);
    }
  }, { rootMargin: '400px 0px' });

  function lazyThumb(img, rec, width) {
    img.dataset.rec = rec;
    img.dataset.w = width;
    img.classList.remove('ready');
    img.removeAttribute('src');
    lazy.observe(img);
  }

  function loadThumb(img) {
    img._loading = true;
    const gen = S.gen;
    thumb(+img.dataset.rec, +img.dataset.w, () => img._visible && img.isConnected)
      .then((url) => {
        if (gen !== S.gen || !img.isConnected) return;
        img.onload = () => img.classList.add('ready');
        img.src = url;
      })
      .catch(() => {})
      .finally(() => { img._loading = false; });
  }

  // ------------------------------------------------ Lesefortschritt (verschluesselt, nur auf diesem Geraet)
  async function initProgress(v) {
    const enc = new TextEncoder();
    const id = new Uint8Array(await crypto.subtle.sign('HMAC', v.macKey, enc.encode('reader/progress-id/v1')));
    const kb = new Uint8Array(await crypto.subtle.sign('HMAC', v.macKey, enc.encode('reader/progress-key/v1')));
    const key = await crypto.subtle.importKey('raw', kb, 'AES-GCM', false, ['encrypt', 'decrypt']);
    kb.fill(0);
    const p = { id: 'reader.p.' + hex(id.subarray(0, 16)), key, data: { c: {} } };
    try {
      const raw = localStorage.getItem(p.id);
      if (raw) {
        const b = b64dec(raw);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12));
        const d = JSON.parse(new TextDecoder().decode(plain));
        if (d && typeof d.c === 'object') p.data = d;
      }
    } catch (e) { /* unlesbar -> neu beginnen */ }
    for (const s of v.series) {
      for (const c of s.chapters) {
        const x = p.data.c[s.index + '.' + c.index];
        if (Array.isArray(x) && x[2] >= c.lastRead) {
          c.lastPage = clamp(x[0] | 0, 0, Math.max(0, c.pages.length - 1));
          c.finished = !!x[1];
          c.lastRead = +x[2] || 0;
        }
        if (c.lastRead > s.lastRead) s.lastRead = c.lastRead;
      }
    }
    S.progress = p;
  }

  let saveTimer = 0;
  function touchProgress(c) {
    if (!S.progress) return;
    c.lastRead = Date.now();
    c.series.lastRead = c.lastRead;
    S.progress.data.c[c.series.index + '.' + c.index] = [c.lastPage, c.finished ? 1 : 0, c.lastRead];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 700);
  }

  async function saveProgress() {
    clearTimeout(saveTimer);
    const p = S.progress;
    if (!p) return;
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, p.key, new TextEncoder().encode(JSON.stringify(p.data))));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      localStorage.setItem(p.id, b64enc(out));
    } catch (e) { /* Speicher nicht verfuegbar */ }
  }

  const chapterProgress = (c) => c.finished ? 1 : (c.lastPage > 0 || c.lastRead > 0) && c.pages.length ? (c.lastPage + 1) / c.pages.length : 0;
  const seriesProgress = (s) => s.chapters.length ? s.chapters.reduce((a, c) => a + chapterProgress(c), 0) / s.chapters.length : 0;
  const firstPage = (s) => { for (const c of s.chapters) if (c.pages.length) return c.pages[0]; return null; };
  function seriesInfo(s) {
    const n = s.chapters.length, r = s.chapters.filter((c) => c.finished).length;
    let t = n === 1 ? '1 Kapitel' : n + ' Kapitel';
    if (r === n && n > 0) t += ' · gelesen'; else if (r > 0) t += ' · ' + r + ' gelesen';
    return t;
  }
  function continueChapter(s) {
    let best = null;
    for (const c of s.chapters) if (!c.finished && (c.lastPage > 0 || c.lastRead > 0) && (!best || c.lastRead > best.lastRead)) best = c;
    if (best) return best;
    for (const c of s.chapters) if (!c.finished) return c;
    return s.chapters[0] || null;
  }

  // ------------------------------------------------ Start & Entsperren
  $('fileInput').addEventListener('change', () => {
    const f = $('fileInput').files && $('fileInput').files[0];
    $('fileInput').value = '';
    if (!f) return;
    S.file = f;
    S.resume = null;
    showUnlock(false);
  });

  function setPwVisible(on) {
    $('pw').type = on ? 'text' : 'password';
    $('pwEye').setAttribute('aria-label', on ? 'Passwort verbergen' : 'Passwort anzeigen');
    $('pwEye').classList.toggle('on', on);
  }
  $('pwEye').addEventListener('click', () => { setPwVisible($('pw').type === 'password'); $('pw').focus(); });

  function showUnlock(relock) {
    $('unlockTitle').textContent = relock ? 'Gesperrt' : 'Passwort eingeben';
    $('unlockText').textContent = relock
      ? 'Gib das Export-Passwort erneut ein, um weiterzulesen.'
      : 'Datei: ' + S.file.name + ' (' + formatSize(S.file.size) + '). Gib das Export-Passwort ein, das du in MangaVault vergeben hast.';
    $('unlockError').hidden = true;
    $('pw').value = '';
    setPwVisible(false);
    show('unlock');
    setTimeout(() => $('pw').focus(), 60);
  }

  function showUnlockError(msg) {
    $('unlockError').textContent = msg;
    $('unlockError').hidden = false;
  }

  let unlocking = false;
  $('unlockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (unlocking || !S.file) return;
    const pw = $('pw').value;
    if (!pw) { showUnlockError('Bitte gib das Passwort ein.'); return; }
    unlocking = true;
    $('unlockBtn').disabled = true;
    $('unlockSpin').hidden = false;
    $('unlockLabel').textContent = 'Wird entschlüsselt …';
    $('unlockError').hidden = true;
    $('pw').blur();
    try {
      const v = await MVX.open(S.file, pw);
      $('pw').value = '';
      setPwVisible(false);
      await enter(v);
    } catch (err) {
      if (err instanceof MVX.WrongPasswordError) showUnlockError('Falsches Passwort. Bitte versuche es erneut.');
      else if (err instanceof MVX.CorruptError) showUnlockError(err.message);
      else showUnlockError('Die Datei konnte nicht gelesen werden. Wähle sie bitte erneut aus.');
      $('pw').select();
    } finally {
      unlocking = false;
      $('unlockBtn').disabled = false;
      $('unlockSpin').hidden = true;
      $('unlockLabel').textContent = 'Öffnen';
    }
  });

  $('otherFile').addEventListener('click', () => {
    S.file = null;
    S.resume = null;
    show('start');
  });

  async function enter(v) {
    S.gen++;
    S.vault = v;
    await initProgress(v);
    v.verifyComplete().catch(() => {
      if (S.vault === v) toast('Achtung: Die Datei ist unvollständig oder beschädigt. Manche Seiten fehlen eventuell.', true);
    });
    lastActivity = Date.now();
    const r = S.resume;
    S.resume = null;
    S.query = '';
    $('search').value = '';
    S.folder = r ? r.folder : null;
    renderLibrary();
    const s = r && r.s >= 0 ? v.series[r.s] : null;
    const c = s && r.c >= 0 ? s.chapters[r.c] : null;
    if (s && c && (r.screen === 'reader' || (r.screen === 'overview' && r.from === 'reader'))) {
      openSeries(s);
      openReader(s, c, r.page);
    } else if (s && (r.screen === 'series' || r.screen === 'overview')) {
      openSeries(s);
    } else {
      show('library');
      $('library').scrollTop = 0;
    }
  }

  // ------------------------------------------------ Sperren
  function lock(full) {
    if (!S.vault) {
      if (full) { S.file = null; S.resume = null; show('start'); }
      return;
    }
    if (!full) {
      // Nur Positionen (Zahlen) im Arbeitsspeicher, damit es nach dem Entsperren dort weitergeht
      S.resume = {
        screen, folder: S.folder,
        s: S.series ? S.series.index : -1,
        c: S.chapter ? S.chapter.index : -1,
        page: S.page,
        from: S.ovFrom,
      };
    }
    saveProgress();
    S.gen++;
    navToken++;
    S.vault.close();
    S.vault = null;
    S.progress = null;
    closeReaderMedia();
    for (const u of thumbs.values()) URL.revokeObjectURL(u);
    thumbs.clear();
    thumbJobs.clear();
    for (const id of ['seriesGrid', 'chapterList', 'ovGrid', 'folderChips']) clearContainer($(id));
    $('seriesCover').removeAttribute('src');
    for (const id of ['rTitle', 'rSub', 'seriesTitle', 'seriesInfo', 'ovTitle', 'ovSub', 'libInfo', 'continueText', 'continueSub']) $(id).textContent = '';
    S.series = S.chapter = S.ovChapter = null;
    if (full) { S.file = null; S.resume = null; show('start'); }
    else showUnlock(true);
  }

  $('closeBtn').addEventListener('click', () => lock(true));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      $('privacy').hidden = false; // Sichtschutz fuer die App-Uebersicht
      if (S.vault) lock(false);
    } else {
      setTimeout(() => { $('privacy').hidden = true; }, 60);
    }
  });
  window.addEventListener('pagehide', () => { if (S.vault) lock(false); });

  for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true });
  document.addEventListener('scroll', () => { lastActivity = Date.now(); }, { passive: true, capture: true });
  setInterval(() => { if (S.vault && Date.now() - lastActivity > IDLE_LOCK_MS) lock(false); }, 15000);

  // ------------------------------------------------ Bibliothek
  $('search').addEventListener('input', () => { S.query = $('search').value; renderLibrary(); });

  function renderLibrary() {
    const v = S.vault;
    if (!v) return;
    const all = v.series;
    const chapters = all.reduce((n, s) => n + s.chapters.length, 0);
    const folderSet = new Set();
    let loose = 0;
    for (const s of all) { if (s.folder) folderSet.add(s.folder); else loose++; }
    const folders = [...folderSet].sort(collator.compare);
    $('libInfo').textContent = (all.length === 1 ? '1 Serie' : all.length + ' Serien') + ' · ' + chapters + ' Kapitel'
      + (folders.length ? ' · ' + folders.length + ' Ordner' : '');

    if (S.folder !== null && S.folder !== '' && !folderSet.has(S.folder)) S.folder = null;
    const chips = $('folderChips');
    clearContainer(chips);
    chips.hidden = folders.length === 0;
    const addChip = (label, value, icon) => {
      const b = el('button', 'chip' + (S.folder === value ? ' on' : ''));
      if (icon) b.innerHTML = ICON_FOLDER;
      b.append(document.createTextNode(label));
      b.addEventListener('click', () => { S.folder = value; renderLibrary(); $('library').scrollTop = 0; });
      chips.append(b);
    };
    if (folders.length) {
      addChip('Alle', null, false);
      for (const f of folders) addChip(f, f, true);
      if (loose > 0) addChip('Ohne Ordner', '', false);
    }

    const q = S.query.trim().toLocaleLowerCase('de');
    const list = all.filter((s) => q ? s.title.toLocaleLowerCase('de').includes(q) : (S.folder === null || s.folder === S.folder));
    list.sort((a, b) => (b.lastRead - a.lastRead) || collator.compare(a.title, b.title));

    const grid = $('seriesGrid');
    clearContainer(grid);
    for (const s of list) grid.append(seriesTile(s));
    $('libEmpty').hidden = list.length > 0;
    $('libEmpty').textContent = q ? 'Keine Serie passt zu deiner Suche.' : 'Keine Serie in diesem Ordner.';
  }

  function seriesTile(s) {
    const b = el('button', 'tile');
    const cv = el('div', 'cover');
    const img = el('img');
    img.alt = '';
    cv.append(img);
    const fp = firstPage(s);
    if (fp) lazyThumb(img, fp.rec, 320);
    const prog = seriesProgress(s);
    if (prog > 0) {
      const p = el('div', 'prog');
      const i = el('i');
      i.style.width = Math.round(prog * 100) + '%';
      p.append(i);
      cv.append(p);
    }
    b.append(cv, el('div', 't', s.title), el('div', 's', seriesInfo(s)));
    b.addEventListener('click', () => openSeries(s));
    return b;
  }

  // ------------------------------------------------ Serie
  function openSeries(s) {
    S.series = s;
    show('series');
    $('series').scrollTop = 0;
    $('seriesTitle').textContent = s.title;
    const pages = s.chapters.reduce((n, c) => n + c.pages.length, 0);
    $('seriesInfo').textContent = seriesInfo(s) + ' · ' + pages + ' Seiten' + (s.folder ? ' · ' + s.folder : '');
    const fp = firstPage(s);
    if (fp) lazyThumb($('seriesCover'), fp.rec, 480); else $('seriesCover').removeAttribute('src');
    $('seriesProgress').firstElementChild.style.width = Math.round(seriesProgress(s) * 100) + '%';

    const c = continueChapter(s);
    $('continueBtn').disabled = !c;
    const started = s.chapters.some((x) => x.lastPage > 0 || x.finished || x.lastRead > 0);
    const allRead = s.chapters.length > 0 && s.chapters.every((x) => x.finished);
    $('continueText').textContent = !c ? 'Keine Kapitel' : allRead ? 'Erneut lesen' : started ? 'Weiterlesen' : 'Lesen starten';
    $('continueSub').textContent = c ? c.title + (!c.finished && c.lastPage > 0 ? ' · Seite ' + (c.lastPage + 1) : '') : '';

    const list = $('chapterList');
    clearContainer(list);
    for (const ch of s.chapters) {
      const li = el('li', 'row');
      const b = el('button', 'chapter');
      const th = el('div', 'cover thumb');
      const img = el('img');
      img.alt = '';
      th.append(img);
      if (ch.pages.length) lazyThumb(img, ch.pages[0].rec, 120);
      const info = el('div', 'info');
      const status = ch.finished ? 'Gelesen' : (ch.lastPage > 0 || ch.lastRead > 0) ? 'Seite ' + (ch.lastPage + 1) + ' von ' + ch.pages.length : ch.pages.length + (ch.pages.length === 1 ? ' Seite' : ' Seiten');
      info.append(el('div', 'ct', ch.title), el('div', 'cs' + (ch.finished ? ' done' : ''), status));
      const prog = chapterProgress(ch);
      if (prog > 0 && !ch.finished) {
        const bar = el('div', 'cbar');
        const i = el('i');
        i.style.width = Math.round(prog * 100) + '%';
        bar.append(i);
        info.append(bar);
      }
      b.append(th, info);
      b.addEventListener('click', () => openReader(s, ch, ch.finished ? 0 : ch.lastPage));
      const ov = el('button', 'iconbtn');
      ov.innerHTML = ICON_GRID;
      ov.setAttribute('aria-label', 'Seitenübersicht');
      ov.addEventListener('click', () => openOverview(ch, 'series'));
      li.append(b, ov);
      list.append(li);
    }
  }

  $('seriesBack').addEventListener('click', () => { S.series = null; renderLibrary(); show('library'); });
  $('continueBtn').addEventListener('click', () => {
    const s = S.series;
    const c = s && continueChapter(s);
    if (c) openReader(s, c, c.finished ? 0 : c.lastPage);
  });

  // ------------------------------------------------ Reader
  let navToken = 0;
  const pageUrls = new Map(); // rec -> { p: Promise<url>, url }

  function pageUrl(rec, urgent) {
    const hit = pageUrls.get(rec);
    if (hit) return hit.p;
    const gen = S.gen;
    const e = {};
    e.p = pageLimit(async () => {
      const blob = await recordBlob(rec);
      if (gen !== S.gen) throw new Error('Gesperrt');
      e.url = URL.createObjectURL(blob);
      return e.url;
    }, urgent);
    e.p.catch(() => { if (pageUrls.get(rec) === e) pageUrls.delete(rec); });
    pageUrls.set(rec, e);
    return e.p;
  }

  function trimPages(keep) {
    for (const [rec, e] of pageUrls) {
      if (keep.has(rec)) continue;
      if (e.url) URL.revokeObjectURL(e.url);
      else e.p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
      pageUrls.delete(rec);
    }
  }

  function closeReaderMedia() {
    navToken++;
    trimPages(new Set());
    clearStrip();
    $('pageImg').removeAttribute('src');
    $('pageSpin').hidden = true;
  }

  function openReader(s, c, page) {
    if (!c.pages.length) { toast('Dieses Kapitel hat keine Seiten', true); return; }
    S.series = s;
    show('reader');
    applyModeUi();
    loadChapter(c, page);
    setHud(true);
  }

  function loadChapter(c, page) {
    S.chapter = c;
    S.page = clamp(page | 0, 0, c.pages.length - 1);
    const s = c.series;
    $('rTitle').textContent = s.title;
    $('rSub').textContent = c.title + ' · Kapitel ' + (c.index + 1) + ' von ' + s.chapters.length;
    $('prevCh').disabled = c.index === 0;
    $('nextCh').disabled = c.index >= s.chapters.length - 1;
    $('slider').max = String(c.pages.length - 1);
    trimPages(new Set());
    if (prefs.mode === 'strip') {
      $('pageView').hidden = true;
      $('pageImg').removeAttribute('src');
      $('stripView').hidden = false;
      buildStrip();
    } else {
      $('stripView').hidden = true;
      clearStrip();
      $('pageView').hidden = false;
      showPage();
    }
  }

  function updatePageUi() {
    const c = S.chapter;
    const n = c.pages.length;
    $('slider').value = String(S.page);
    $('pageText').textContent = (S.page + 1) + ' / ' + n;
    c.lastPage = S.page;
    if (S.page >= n - 1) c.finished = true;
    touchProgress(c);
  }

  async function showPage() {
    const c = S.chapter;
    if (!c) return;
    const token = ++navToken;
    const p = c.pages[S.page];
    updatePageUi();
    const spin = setTimeout(() => { if (token === navToken) $('pageSpin').hidden = false; }, 150);
    let url;
    try {
      url = await pageUrl(p.rec, true);
    } catch (err) {
      clearTimeout(spin);
      if (token === navToken) {
        $('pageSpin').hidden = true;
        if (S.vault) toast('Seite kann nicht geladen werden: ' + err.message, true);
      }
      return;
    }
    clearTimeout(spin);
    if (token !== navToken || !S.vault) return;
    const img = $('pageImg');
    await new Promise((res) => { img.onload = img.onerror = res; img.src = url; });
    if (token !== navToken) return;
    $('pageSpin').hidden = true;
    layoutStage(img.naturalWidth || p.w, img.naturalHeight || p.h);
    // Nachbarseiten vorbereiten, Rest freigeben
    const keep = new Set();
    for (let i = S.page - 1; i <= S.page + 3; i++) if (i >= 0 && i < c.pages.length) keep.add(c.pages[i].rec);
    trimPages(keep);
    for (const i of [S.page + 1, S.page + 2, S.page - 1]) if (i >= 0 && i < c.pages.length) pageUrl(c.pages[i].rec).catch(() => {});
  }

  function next() {
    const c = S.chapter;
    if (!c) return;
    if (S.page < c.pages.length - 1) { S.page++; showPage(); } else stepChapter(1, false);
  }
  function prev() {
    if (!S.chapter) return;
    if (S.page > 0) { S.page--; showPage(); } else stepChapter(-1, true);
  }
  function goPage(p) {
    if (!S.chapter) return;
    p = clamp(p, 0, S.chapter.pages.length - 1);
    if (prefs.mode === 'strip') scrollStripTo(p);
    else { S.page = p; showPage(); }
  }
  function stepChapter(d, toEnd) {
    const c = S.chapter;
    const s = c.series;
    const i = c.index + d;
    if (d > 0) { c.finished = true; touchProgress(c); }
    if (i < 0) { toast('Das ist das erste Kapitel'); return; }
    if (i >= s.chapters.length) { toast('Ende der Serie erreicht'); return; }
    const n = s.chapters[i];
    loadChapter(n, toEnd ? n.pages.length - 1 : 0);
    toast(n.title);
  }

  // ---------- Leisten
  let hudOn = true, hudTimer = 0;
  function setHud(on) {
    hudOn = on;
    $('reader').classList.toggle('hud-off', !on);
    clearTimeout(hudTimer);
    if (on) hudTimer = setTimeout(() => { if (screen === 'reader') setHud(false); }, 4000);
  }
  for (const id of ['hudTop', 'hudBottom']) {
    $(id).addEventListener('pointerdown', () => { if (hudOn) setHud(true); });
  }

  function applyModeUi() {
    $('modeBtn').textContent = prefs.mode === 'page' ? 'Seite' : 'Vertikal';
    $('dirBtn').textContent = prefs.rtl ? 'R → L' : 'L → R';
    $('dirBtn').disabled = prefs.mode === 'strip';
    $('slider').classList.toggle('rtl', prefs.rtl && prefs.mode === 'page');
  }

  $('modeBtn').addEventListener('click', () => {
    prefs.mode = prefs.mode === 'page' ? 'strip' : 'page';
    savePrefs();
    applyModeUi();
    if (S.chapter) loadChapter(S.chapter, S.page);
    toast(prefs.mode === 'page' ? 'Ansicht: Einzelseite' : 'Ansicht: Vertikal (Webtoon)');
  });
  $('dirBtn').addEventListener('click', () => {
    prefs.rtl = !prefs.rtl;
    savePrefs();
    applyModeUi();
    toast(prefs.rtl ? 'Leserichtung: rechts nach links (Manga)' : 'Leserichtung: links nach rechts (Comic)');
  });
  $('readerBack').addEventListener('click', closeReader);
  $('prevCh').addEventListener('click', () => stepChapter(-1, false));
  $('nextCh').addEventListener('click', () => stepChapter(1, false));
  $('ovBtn').addEventListener('click', () => { if (S.chapter) openOverview(S.chapter, 'reader'); });

  let slideTimer = 0;
  $('slider').addEventListener('input', () => {
    const p = +$('slider').value;
    $('pageText').textContent = (p + 1) + ' / ' + S.chapter.pages.length;
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => goPage(p), 120);
    setHud(true);
  });

  function closeReader() {
    const s = S.chapter ? S.chapter.series : S.series;
    saveProgress();
    closeReaderMedia();
    S.chapter = null;
    if (s) openSeries(s); else { renderLibrary(); show('library'); }
  }

  // ---------- Zoom & Gesten (Einzelseite)
  const Z = { s: 1, tx: 0, ty: 0, fitW: 0, fitH: 0, ox: 0, oy: 0, vw: 0, vh: 0, iw: 0, ih: 0 };

  function layoutStage(w, h) {
    const pv = $('pageView');
    Z.vw = pv.clientWidth;
    Z.vh = pv.clientHeight;
    Z.iw = w; Z.ih = h;
    const f = Math.min(Z.vw / w, Z.vh / h);
    Z.fitW = w * f; Z.fitH = h * f;
    Z.ox = (Z.vw - Z.fitW) / 2; Z.oy = (Z.vh - Z.fitH) / 2;
    const st = $('stage').style;
    st.left = Z.ox + 'px'; st.top = Z.oy + 'px';
    st.width = Z.fitW + 'px'; st.height = Z.fitH + 'px';
    Z.s = 1; Z.tx = 0; Z.ty = 0;
    applyZoom(false);
  }

  function clampPan() {
    const W = Z.fitW * Z.s, H = Z.fitH * Z.s;
    Z.tx = W <= Z.vw ? (Z.vw - W) / 2 - Z.ox : clamp(Z.tx, Z.vw - Z.ox - W, -Z.ox);
    Z.ty = H <= Z.vh ? (Z.vh - H) / 2 - Z.oy : clamp(Z.ty, Z.vh - Z.oy - H, -Z.oy);
  }

  function applyZoom(anim, dx) {
    const st = $('stage');
    st.classList.toggle('anim', !!anim);
    st.style.transform = 'translate(' + (Z.tx + (dx || 0)) + 'px,' + Z.ty + 'px) scale(' + Z.s + ')';
  }

  function zoomAt(s, px, py, anim) {
    s = clamp(s, 1, 5);
    const cx = (px - Z.ox - Z.tx) / Z.s, cy = (py - Z.oy - Z.ty) / Z.s;
    Z.s = s;
    Z.tx = px - Z.ox - cx * s;
    Z.ty = py - Z.oy - cy * s;
    clampPan();
    applyZoom(anim);
  }

  const pv = $('pageView');
  const pts = new Map();
  let G = null, lastTap = null, tapTimer = 0;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  pv.addEventListener('pointerdown', (e) => {
    try { pv.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      G = { type: 'one', sx: e.clientX, sy: e.clientY, t: performance.now(), tx0: Z.tx, ty0: Z.ty, moved: false };
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      G = { type: 'pinch', d0: dist(a, b), s0: Z.s, m0: mid(a, b), tx0: Z.tx, ty0: Z.ty };
      clearTimeout(tapTimer);
      lastTap = null;
    }
  });

  pv.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!G) return;
    if (G.type === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const m = mid(a, b);
      const s = clamp(G.s0 * dist(a, b) / G.d0, 1, 5);
      const cx = (G.m0.x - Z.ox - G.tx0) / G.s0, cy = (G.m0.y - Z.oy - G.ty0) / G.s0;
      Z.s = s;
      Z.tx = m.x - Z.ox - cx * s;
      Z.ty = m.y - Z.oy - cy * s;
      clampPan();
      applyZoom(false);
    } else if (G.type === 'one') {
      const dx = e.clientX - G.sx, dy = e.clientY - G.sy;
      if (!G.moved && Math.hypot(dx, dy) > 8) G.moved = true;
      if (!G.moved) return;
      if (Z.s > 1.01) {
        Z.tx = G.tx0 + dx;
        Z.ty = G.ty0 + dy;
        clampPan();
        applyZoom(false);
      } else {
        applyZoom(false, dx * 0.45); // Vorschau beim Wischen
      }
    }
  });

  function endPointer(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!G) return;
    if (G.type === 'pinch') {
      if (pts.size === 1) {
        const [a] = [...pts.values()];
        G = { type: 'one', sx: a.x, sy: a.y, t: 0, tx0: Z.tx, ty0: Z.ty, moved: true, afterPinch: true };
      } else if (pts.size === 0) {
        if (Z.s < 1.05) { Z.s = 1; clampPan(); applyZoom(true); }
        G = null;
      }
      return;
    }
    if (pts.size > 0) return;
    const g = G;
    G = null;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (!g.moved && e.type === 'pointerup' && performance.now() - g.t < 400) { onTap(e.clientX, e.clientY); return; }
    if (Z.s <= 1.01) {
      if (!g.afterPinch && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        applyZoom(false);
        if (dx < 0) { if (prefs.rtl) prev(); else next(); } else { if (prefs.rtl) next(); else prev(); }
      } else applyZoom(true);
    }
  }
  pv.addEventListener('pointerup', endPointer);
  pv.addEventListener('pointercancel', endPointer);

  function onTap(x, y) {
    const now = performance.now();
    if (lastTap && now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
      clearTimeout(tapTimer);
      lastTap = null;
      if (Z.s > 1.01) { Z.s = 1; clampPan(); applyZoom(true); } else zoomAt(2.5, x, y, true);
      return;
    }
    lastTap = { x, y, t: now };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      lastTap = null;
      if (Z.s > 1.01) { setHud(!hudOn); return; }
      const f = x / Math.max(1, Z.vw);
      if (f < 0.3) { if (prefs.rtl) next(); else prev(); }
      else if (f > 0.7) { if (prefs.rtl) prev(); else next(); }
      else setHud(!hudOn);
    }, 250);
  }

  let lastWheel = 0;
  pv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (Z.s > 1.01) {
      Z.tx -= e.deltaX; Z.ty -= e.deltaY;
      clampPan(); applyZoom(false);
      return;
    }
    const now = performance.now();
    if (now - lastWheel < 260 || Math.abs(e.deltaY) < 4) return;
    lastWheel = now;
    if (e.deltaY > 0) next(); else prev();
  }, { passive: false });

  window.addEventListener('resize', () => {
    if (screen === 'reader' && prefs.mode === 'page' && Z.iw) layoutStage(Z.iw, Z.ih);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (screen === 'reader') {
      const page = prefs.mode === 'page';
      if (e.key === 'Escape') closeReader();
      else if (page && e.key === 'ArrowRight') { if (prefs.rtl) prev(); else next(); }
      else if (page && e.key === 'ArrowLeft') { if (prefs.rtl) next(); else prev(); }
      else if (page && (e.key === ' ' || e.key === 'PageDown' || e.key === 'ArrowDown')) next();
      else if (page && (e.key === 'PageUp' || e.key === 'ArrowUp')) prev();
      else return;
      e.preventDefault();
    } else if (screen === 'overview' && e.key === 'Escape') closeOverview();
    else if (screen === 'series' && e.key === 'Escape') $('seriesBack').click();
  });

  // ---------- Vertikal (Webtoon)
  let stripObs = null, stripRaf = 0;

  function clearStrip() {
    if (stripObs) { stripObs.disconnect(); stripObs = null; }
    for (const d of $('strip').children) if (d._url) URL.revokeObjectURL(d._url);
    $('strip').textContent = '';
  }

  function buildStrip() {
    clearStrip();
    const c = S.chapter;
    const strip = $('strip');
    stripObs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const d = e.target;
        d._want = e.isIntersecting;
        if (e.isIntersecting) loadStripPage(d);
        else unloadStripPage(d);
      }
    }, { root: $('stripView'), rootMargin: '150% 0px' });
    c.pages.forEach((p, i) => {
      const d = el('div', 'spage');
      d.style.aspectRatio = Math.max(1, p.w) + ' / ' + Math.max(1, p.h);
      d.dataset.i = i;
      d.append(el('div', 'n', String(i + 1)));
      strip.append(d);
      stripObs.observe(d);
    });
    const last = c.index >= c.series.chapters.length - 1;
    $('stripNext').textContent = last ? 'Ende der Serie' : 'Nächstes Kapitel ›';
    $('stripNext').disabled = last;
    const target = S.page;
    requestAnimationFrame(() => { scrollStripTo(target); updatePageUi(); });
  }

  function loadStripPage(d) {
    if (d._img || d._loading) return;
    d._loading = true;
    const rec = S.chapter.pages[+d.dataset.i].rec;
    const gen = S.gen;
    pageLimit(async () => {
      if (!d.isConnected || !d._want) return null;
      return URL.createObjectURL(await recordBlob(rec));
    }).then((url) => {
      d._loading = false;
      if (!url) return;
      if (gen !== S.gen || !d.isConnected || !d._want) { URL.revokeObjectURL(url); return; }
      const img = el('img');
      img.alt = '';
      img.src = url;
      d._img = img;
      d._url = url;
      d.append(img);
    }).catch(() => { d._loading = false; });
  }

  function unloadStripPage(d) {
    if (!d._img) return;
    d._img.remove();
    d._img = null;
    URL.revokeObjectURL(d._url);
    d._url = null;
  }

  function scrollStripTo(p) {
    const d = $('strip').children[p];
    if (d) $('stripView').scrollTop = d.offsetTop;
  }

  $('stripView').addEventListener('scroll', () => {
    if (stripRaf) return;
    stripRaf = requestAnimationFrame(() => { stripRaf = 0; onStripScroll(); });
  }, { passive: true });

  function onStripScroll() {
    const c = S.chapter;
    if (!c || prefs.mode !== 'strip' || screen !== 'reader') return;
    const sv = $('stripView');
    const kids = $('strip').children;
    if (!kids.length) return;
    const y = sv.scrollTop + sv.clientHeight * 0.3;
    let lo = 0, hi = kids.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (kids[m].offsetTop <= y) lo = m; else hi = m - 1;
    }
    if (lo !== S.page) { S.page = lo; updatePageUi(); }
    if (sv.scrollTop + sv.clientHeight >= sv.scrollHeight - 4 && !c.finished) { c.finished = true; touchProgress(c); }
  }

  $('stripView').addEventListener('click', (e) => { if (e.target.closest('button')) return; setHud(!hudOn); });
  $('stripNext').addEventListener('click', () => stepChapter(1, false));

  // ------------------------------------------------ Seitenuebersicht
  function openOverview(c, from) {
    S.ovChapter = c;
    S.ovFrom = from;
    show('overview');
    renderOverview(null);
  }

  function renderOverview(focus) {
    const c = S.ovChapter;
    const s = c.series;
    $('ovTitle').textContent = s.title;
    $('ovSub').textContent = c.title + ' · ' + c.pages.length + (c.pages.length === 1 ? ' Seite' : ' Seiten') + ' · Kapitel ' + (c.index + 1) + ' von ' + s.chapters.length;
    $('ovPrev').disabled = c.index === 0;
    $('ovNext').disabled = c.index >= s.chapters.length - 1;
    $('ovSmaller').disabled = prefs.tile === 0;
    $('ovLarger').disabled = prefs.tile === 3;
    document.documentElement.style.setProperty('--tile', TILES[prefs.tile] + 'px');
    const cur = S.ovFrom === 'reader' && c === S.chapter ? S.page : (!c.finished && c.lastPage > 0 ? c.lastPage : -1);
    const grid = $('ovGrid');
    clearContainer(grid);
    const w = Math.round(TILES[prefs.tile] * 2);
    c.pages.forEach((p, i) => {
      const b = el('button', 'ovtile' + (i === cur ? ' current' : ''));
      const cv = el('div', 'cover');
      cv.append(el('div', 'num', String(i + 1)));
      const img = el('img');
      img.alt = '';
      cv.append(img);
      b.append(cv, el('div', 'lbl', String(i + 1)));
      b.addEventListener('click', () => pickPage(i));
      grid.append(b);
      lazyThumb(img, p.rec, w);
    });
    requestAnimationFrame(() => {
      const ov = $('overview');
      const idx = focus != null ? focus : cur;
      const t = idx > 0 ? grid.children[idx] : null;
      ov.scrollTop = t ? Math.max(0, t.offsetTop - (focus != null ? 90 : ov.clientHeight / 3)) : 0;
    });
  }

  function pickPage(i) {
    const c = S.ovChapter;
    if (S.ovFrom === 'reader' && S.chapter) {
      show('reader');
      if (c !== S.chapter) loadChapter(c, i); else goPage(i);
      if (prefs.mode === 'page' && Z.iw && c === S.chapter) layoutStage(Z.iw, Z.ih);
    } else openReader(c.series, c, i);
  }

  function closeOverview() {
    if (S.ovFrom === 'reader' && S.chapter) {
      show('reader');
      if (prefs.mode === 'strip') scrollStripTo(S.page); else if (Z.iw) layoutStage(Z.iw, Z.ih);
    } else if (S.series) openSeries(S.series);
    else show('library');
  }

  function changeTile(d) {
    const t = clamp(prefs.tile + d, 0, 3);
    if (t === prefs.tile) return;
    const ov = $('overview');
    let focus = 0;
    for (const k of $('ovGrid').children) { if (k.offsetTop + k.offsetHeight > ov.scrollTop + 60) break; focus++; }
    prefs.tile = t;
    savePrefs();
    renderOverview(focus);
  }

  $('ovClose').addEventListener('click', closeOverview);
  $('ovSmaller').addEventListener('click', () => changeTile(-1));
  $('ovLarger').addEventListener('click', () => changeTile(1));
  $('ovPrev').addEventListener('click', () => { const c = S.ovChapter; if (c && c.index > 0) { S.ovChapter = c.series.chapters[c.index - 1]; renderOverview(null); } });
  $('ovNext').addEventListener('click', () => { const c = S.ovChapter; if (c && c.index < c.series.chapters.length - 1) { S.ovChapter = c.series.chapters[c.index + 1]; renderOverview(null); } });

  // ------------------------------------------------ Start
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !navigator.standalone) $('installHint').hidden = false;
  if (!window.crypto || !crypto.subtle) {
    $('installHint').hidden = false;
    $('installHint').textContent = 'Dieser Browser unterstützt die nötige Verschlüsselung nicht. Bitte öffne den Reader über eine https-Adresse in Safari.';
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
