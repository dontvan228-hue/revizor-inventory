// Распознавание товара: штрихкод на фото, визуальное сходство (нейросеть на телефоне),
// чтение текста с этикетки (OCR) и, по желанию, ИИ Claude по API-ключу.
const Recog = (() => {
  const loaded = {};
  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error('Не удалось загрузить ' + src)); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  // ---------- картинки ----------
  function fileToImage(fileOrUrl) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('Не удалось открыть изображение'));
      img.src = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl);
    });
  }
  function toDataURL(img, max = 640, quality = 0.8, square = false) {
    const c = document.createElement('canvas');
    let sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height, sx = 0, sy = 0;
    if (square) { const m = Math.min(sw, sh); sx = (sw - m) / 2; sy = (sh - m) / 2; sw = sh = m; }
    const k = Math.min(1, max / Math.max(sw, sh));
    c.width = Math.round(sw * k); c.height = Math.round(sh * k);
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }

  // ---------- штрихкод на фото ----------
  async function barcodeFromFile(file) {
    if ('BarcodeDetector' in window) {
      try {
        const det = new BarcodeDetector();
        const img = await fileToImage(file);
        const found = await det.detect(img);
        if (found.length) return found[0].rawValue;
      } catch { /* fallback ниже */ }
    }
    if (window.Html5Qrcode) {
      let el = document.getElementById('hiddenReader');
      if (!el) { el = document.createElement('div'); el.id = 'hiddenReader'; el.style.display = 'none'; document.body.appendChild(el); }
      try { const h = new Html5Qrcode('hiddenReader'); const t = await h.scanFile(file, false); h.clear(); return t; } catch { return null; }
    }
    return null;
  }

  // ---------- визуальное сходство (MobileNet, работает на телефоне) ----------
  let modelP = null;
  function loadModel() {
    if (modelP) return modelP;
    modelP = (async () => {
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js');
      return mobilenet.load({ version: 1, alpha: 1.0 });
    })();
    modelP.catch(() => { modelP = null; });
    return modelP;
  }
  const modelReady = () => !!modelP;
  async function embed(imgOrUrl) {
    const model = await loadModel();
    const img = typeof imgOrUrl === 'string' ? await fileToImage(imgOrUrl) : imgOrUrl;
    const t = tf.tidy(() => model.infer(img, true));
    const v = Array.from(await t.data()); t.dispose();
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    return v.map(x => +(x / n).toFixed(5));
  }
  function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
  function visualMatch(vec, items, top = 5) {
    const out = [];
    for (const it of items) {
      if (!it.emb || !it.emb.length) continue;
      let best = -1; for (const e of it.emb) best = Math.max(best, cosine(vec, e));
      out.push({ item: it, score: best });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, top);
  }

  // ---------- текст ----------
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
  function textScore(q, it) {
    const nq = norm(q); if (!nq) return 0;
    const hay = norm([it.name, it.sku, it.barcode, it.category].join(' '));
    if (it.barcode && nq.replace(/\s/g, '').includes(String(it.barcode))) return 1;
    if (it.sku && nq.split(' ').includes(norm(it.sku))) return 0.95;
    const qt = new Set(nq.split(' ').filter(w => w.length > 1));
    const ht = new Set(hay.split(' ').filter(w => w.length > 1));
    if (!qt.size || !ht.size) return 0;
    let hit = 0; for (const w of ht) { for (const x of qt) { if (x === w || (w.length > 3 && (x.startsWith(w) || w.startsWith(x)))) { hit++; break; } } }
    return hit / ht.size * 0.9;
  }
  // Поиск по вводу пользователя: какая доля слов запроса есть в товаре (начало слова тоже считается)
  function qScore(q, it) {
    const qt = norm(q).split(' ').filter(Boolean); if (!qt.length) return 0;
    const extra = norm([it.code, it.sku, it.barcode, ...(it.barcodes || [])].join(' '));
    const hw = (norm(it.name) + ' ' + extra).split(' ');
    let hit = 0; for (const w of qt) if (hw.some(h => h.startsWith(w) || (w.length > 3 && h.startsWith(w.slice(0, -1))))) hit++;
    return hit / qt.length;
  }
  function search(q, items, top = 30) {
    return items.map(i => ({ i, s: qScore(q, i) })).filter(x => x.s >= 0.99 || (x.s >= 0.6 && norm(q).split(' ').length > 2))
      .sort((a, b) => b.s - a.s || ((+b.i.qty || 0) > 0) - ((+a.i.qty || 0) > 0)).slice(0, top).map(x => x.i);
  }
  function textMatch(q, items, top = 5) {
    return items.map(it => ({ item: it, score: textScore(q, it) })).filter(x => x.score > 0.2)
      .sort((a, b) => b.score - a.score).slice(0, top);
  }

  // ---------- OCR (Tesseract, грузится по требованию) ----------
  async function ocr(file, onProgress) {
    await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    const r = await Tesseract.recognize(file, 'rus+eng', { logger: m => onProgress && m.progress && onProgress(m) });
    return r.data.text || '';
  }

  // ---------- ИИ Claude (по API-ключу пользователя, ключ хранится только на телефоне) ----------
  async function askClaude(dataUrl, items, cfg) {
    if (!cfg.apiKey) throw new Error('Нет API-ключа Claude (Ещё → Настройки)');
    // весь каталог (порядок стабильный — чтобы работал кэш промпта и повторные фото стоили дёшево)
    const catalog = items.slice().sort((a, b) => a.id < b.id ? -1 : 1).slice(0, 4000).map(i => `${i.id}|${i.name}|${i.sku || ''}|${i.barcode || ''}`).join('\n');
    const schema = {
      type: 'object', additionalProperties: false,
      required: ['match_id', 'name', 'category', 'brand', 'label_text', 'barcode', 'count_visible', 'confidence'],
      properties: {
        match_id: { type: 'string', description: 'id товара из каталога или пустая строка' },
        name: { type: 'string' }, category: { type: 'string' }, brand: { type: 'string' },
        label_text: { type: 'string' }, barcode: { type: 'string' },
        count_visible: { type: 'integer', description: 'сколько одинаковых единиц товара видно на фото' },
        confidence: { type: 'number' }
      }
    };
    const body = {
      model: cfg.model || 'claude-opus-5-5',
      max_tokens: 2000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system: [{ type: 'text', cache_control: { type: 'ephemeral' }, text:
`Ты помогаешь проводить инвентаризацию в магазине. По фото определяешь товар и находишь его в каталоге.
В каталоге один и тот же товар может быть заведён под разными названиями (на русском и английском, с префиксами вроде «ОЭСДН», «Электронная сигарета», «Жидкость для ЭСДН»). Сравнивай по бренду, линейке, крепости/объёму/затяжкам и вкусу.
Каталог (id|название|артикул|штрихкод):
${catalog || '(каталог пуст)'}` }],
      messages: [{
        role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataUrl.split(',')[1] } },
          { type: 'text', text:
`Определи товар на фото.
Если товар есть в каталоге — верни его id в match_id, иначе пустую строку.
name — короткое понятное название на русском, category — категория, brand — бренд (или пусто),
label_text — главный текст с этикетки, barcode — цифры штрихкода, если видны (или пусто),
count_visible — сколько одинаковых единиц видно, confidence — уверенность 0..1.` }
        ]
      }]
    };
    const useFallback = /^claude-(opus-5-5|sonnet-5-5)$/.test(body.model);
    if (useFallback) body.fallbacks = 'default';
    const headers = {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    if (useFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Claude: ' + (j.error && j.error.message || r.status));
    if (j.stop_reason === 'refusal') throw new Error('Claude отказался обработать это фото');
    if (j.stop_reason === 'max_tokens') throw new Error('Claude: ответ обрезан, попробуйте ещё раз');
    const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    try { return JSON.parse(txt); } catch { throw new Error('Claude вернул непонятный ответ'); }
  }

  return { loadScript, fileToImage, toDataURL, barcodeFromFile, loadModel, modelReady, embed, visualMatch, textMatch, textScore, qScore, search, ocr, askClaude, norm };
})();
