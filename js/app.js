// Ревизор — инвентаризация с телефона. Весь интерфейс и логика.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => (Math.round((+n || 0) * 100) / 100).toLocaleString('ru-RU');
  const money = n => (+n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
  const view = $('#view');

  let items = [];
  let session = null;          // активная ревизия
  let S = {};                  // настройки
  let scanner = null;          // Html5Qrcode
  let tick = null;
  let countMode = 'scan';
  let lastItemId = null;
  let lastCode = { code: '', t: 0 };

  const DEFAULTS = { apiKey: '', model: 'claude-opus-5-5', aiAuto: false, visual: true, plusOne: true, beep: true, vibrate: true, theme: 'auto', locations: ['Склад', 'Торговый зал'], loc: 'Склад' };

  // ---------- утилиты UI ----------
  function toast(msg, ms = 2200) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }
  let onModalClose = null;
  function modal(title, html, mount) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    $('#modal').hidden = false;
    onModalClose = null;
    if (mount) mount($('#modalBody'));
  }
  function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; const f = onModalClose; onModalClose = null; if (f) f(); }
  $('#modalClose').onclick = closeModal;
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  function confirmBox(text, okText = 'Да') {
    return new Promise(res => {
      modal('Подтвердите', `<p>${esc(text)}</p><div class="row"><button class="btn grow" id="cNo">Отмена</button><button class="btn primary grow" id="cYes">${esc(okText)}</button></div>`, b => {
        onModalClose = () => res(false);
        $('#cNo', b).onclick = () => closeModal();
        $('#cYes', b).onclick = () => { onModalClose = null; closeModal(); res(true); };
      });
    });
  }
  function pickFile(accept, { multiple = false, capture = false } = {}) {
    return new Promise(res => {
      const i = document.createElement('input');
      i.type = 'file'; i.accept = accept; i.multiple = multiple;
      if (capture) i.setAttribute('capture', 'environment');
      i.onchange = () => res(multiple ? Array.from(i.files) : i.files[0]);
      i.click();
    });
  }
  let actx = null;
  function feedback(ok = true) {
    if (S.vibrate && navigator.vibrate) navigator.vibrate(ok ? 40 : [60, 60, 60]);
    if (!S.beep) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = ok ? 1250 : 330; g.gain.value = 0.08;
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + (ok ? 0.08 : 0.25));
    } catch { }
  }
  function voiceInput(onText) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('Голосовой ввод не поддерживается этим браузером');
    const r = new SR(); r.lang = 'ru-RU'; r.interimResults = false;
    r.onresult = e => onText(e.results[0][0].transcript);
    r.onerror = () => toast('Не расслышал, попробуйте ещё');
    r.start(); toast('Говорите…');
  }
  const saveS = () => DB.kvSet('settings', S);
  function applyTheme() {
    if (S.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', S.theme);
  }

  // ---------- данные ----------
  async function reload() {
    items = (await DB.all('items')).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const sid = await DB.kvGet('activeSession', null);
    session = sid ? await DB.get('sessions', sid) : null;
    if (session && session.finishedAt) session = null;
  }
  const byId = id => items.find(i => i.id === id);
  const findCode = code => {
    const c = String(code).trim();
    return items.find(i => i.barcode && String(i.barcode) === c) || items.find(i => (i.barcodes || []).includes(c)) || items.find(i => i.code && String(i.code) === c) || items.find(i => i.sku && String(i.sku).toLowerCase() === c.toLowerCase()) || items.find(i => i.id === c);
  };
  async function saveItem(it) { it.updatedAt = Date.now(); await DB.put('items', it); const i = items.findIndex(x => x.id === it.id); if (i >= 0) items[i] = it; else items.push(it); }
  const saveSession = () => DB.put('sessions', session);
  const safeImg = u => /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(u || '') ? u : '';
  const thumb = it => it && it.photos && safeImg(it.photos[0]) ? `<img class="thumb" src="${safeImg(it.photos[0])}" alt="">` : `<div class="thumb">📦</div>`;
  const categories = () => [...new Set(items.map(i => i.category).filter(Boolean))].sort();

  // ---------- маршрутизация ----------
  const routes = { home: renderHome, items: renderItems, count: renderCount, files: renderFiles, more: renderMore, report: renderReport, labels: renderLabels, sessions: renderSessions };
  async function route() {
    const [name, arg] = (location.hash.slice(1) || 'home').split('/');
    if (name !== 'count') await stopScanner();
    clearInterval(tick); tick = null;
    $$('#tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
    const titles = { home: 'Ревизор', items: 'Товары', count: 'Подсчёт', files: 'Файлы', more: 'Ещё', report: 'Отчёт', labels: 'Этикетки', sessions: 'История ревизий' };
    $('#title').textContent = titles[name] || 'Ревизор';
    view.innerHTML = '';
    window.scrollTo(0, 0);
    await (routes[name] || renderHome)(arg);
  }
  window.addEventListener('hashchange', route);

  // ---------- главная ----------
  async function renderHome() {
    const total = items.reduce((s, i) => s + (+i.qty || 0), 0);
    const sum = items.reduce((s, i) => s + (+i.qty || 0) * (+i.price || 0), 0);
    const low = items.filter(i => (+i.minQty || 0) > 0 && (+i.qty || 0) <= +i.minQty && (+i.qty || 0) >= 0);
    const negs = IO.negativeSuspects(items);
    const sess = session ? progress() : null;
    view.innerHTML = `
      <div class="grid three">
        <div class="stat"><b>${items.length}</b><span>товаров</span></div>
        <div class="stat"><b>${fmt(total)}</b><span>единиц</span></div>
        <div class="stat"><b>${sum >= 1e6 ? fmt(sum / 1e6) + ' млн' : fmt(Math.round(sum))}</b><span>₽ на складе</span></div>
      </div>
      ${session ? `
      <div class="card" style="margin-top:12px">
        <div class="row between"><b>Идёт ревизия: ${esc(session.name)}</b><span class="pill ok">активна</span></div>
        <div class="progress" style="margin:10px 0"><i style="width:${sess.pct}%"></i></div>
        <div class="small muted">Посчитано ${sess.done} из ${sess.total} позиций · ${sess.elapsed} · ${sess.speed}</div>
        <div class="row" style="margin-top:10px"><a class="btn primary grow" href="#count">Продолжить</a><a class="btn grow" href="#report/${session.id}">Отчёт</a></div>
      </div>` : `
      <div class="card" style="margin-top:12px">
        <b>Начать инвентаризацию</b>
        <p class="small muted">Загрузите остатки из Excel или 1С, затем считайте: сканером, по фото или поиском. В конце — сличительная ведомость в Excel.</p>
        <div class="row wrap"><a class="btn primary grow" href="#count">📷 Начать ревизию</a><button class="btn grow" id="hImport">⬆️ Загрузить Excel</button></div>
      </div>`}
      <h3>Быстрые действия</h3>
      <div class="grid two">
        <button class="btn" id="hAdd">➕ Новый товар</button>
        <button class="btn" id="hPhoto">🔍 Что это за товар?</button>
        <button class="btn" id="hExport">⬇️ Каталог в Excel</button>
        <a class="btn" href="#labels">🏷️ Этикетки с QR</a>
      </div>
      ${negs.length ? `<div class="card" style="border-color:var(--bad)"><b class="diff-neg">⚠️ В минусе по учёту: ${negs.length}</b>
        <p class="small muted" style="margin:6px 0">Минус почти всегда значит пересорт (продали/пробили один товар вместо похожего) или непроведённый приход. Посчитайте эти товары и их «соседей» первыми.</p>
        <div class="list">${negs.slice(0, 5).map(x => itemRow(x.neg) + (x.partners.length ? `<div class="small muted" style="margin:-4px 0 4px 12px">↳ возможно путают с: ${x.partners.map(p => esc(p.name) + ' (' + fmt(p.qty) + ')').join(', ')}</div>` : '')).join('')}</div>
        <a class="btn block" href="#items" id="hNeg" style="margin-top:8px">Все минусовые →</a></div>` : ''}
      ${low.length ? `<h3>Заканчивается (${low.length})</h3><div class="list">${low.slice(0, 8).map(itemRow).join('')}</div>` : ''}
      <h3>Как посчитать склад за час</h3>
      <div class="card small">
        <ol style="margin:0;padding-left:18px;line-height:1.6">
          <li>Выгрузите каталог с остатками из Saby в Excel и загрузите сюда («Ещё → Импорт»). Подробно — «Ещё → Как работать с Saby».</li>
          <li>Разбейте склад на зоны и раздайте зоны людям — у каждого свой телефон, потом объедините файлы.</li>
          <li>Режим <b>Сканер</b>: каждый пик = +1. Для коробок жмите +10/+24 или вводите число.</li>
          <li>Нет штрихкода — режим <b>Фото</b>: приложение узнает товар по снимку.</li>
          <li>Нажмите «Завершить» → «Файл для Saby» и загрузите его в документ «Инвентаризация» в Saby.</li>
        </ol>
      </div>`;
    const h = $('#hImport'); if (h) h.onclick = doImport;
    $('#hAdd').onclick = () => editItem();
    $('#hPhoto').onclick = () => photoFlow({ countIt: false });
    $('#hExport').onclick = () => IO.exportCatalog('xlsx');
    const hn = $('#hNeg'); if (hn) hn.onclick = () => { itemsFilter.cat = '__neg'; };
    bindItemRows();
  }

  // ---------- товары ----------
  function itemRow(it) {
    const c = session && session.counts[it.id];
    return `<div class="item" data-id="${it.id}">${thumb(it)}
      <div class="grow"><div class="name">${esc(it.name)}</div>
      <div class="meta">${esc([it.sku, it.barcode, it.location, it.category].filter(Boolean).join(' · ') || '—')}</div></div>
      <div class="qty ${(+it.qty || 0) < 0 ? 'diff-neg' : ''}">${fmt(it.qty)}<div class="small muted">${esc(it.unit || 'шт')}${c ? ` · факт ${fmt(c.qty)}` : ''}</div></div></div>`;
  }
  function bindItemRows(root = view) { $$('.item[data-id]', root).forEach(el => el.onclick = () => editItem(byId(el.dataset.id))); }
  let itemsFilter = { q: '', cat: '' };
  async function renderItems() {
    const cats = categories();
    const negCount = items.filter(i => (+i.qty || 0) < 0).length;
    view.innerHTML = `
      <div class="search"><div class="row">
        <input type="search" id="q" placeholder="Поиск: название, артикул, штрихкод" value="${esc(itemsFilter.q)}">
        <button class="btn" id="qVoice" title="Голосом">🎤</button><button class="btn" id="qScan" title="Сканировать">▦</button></div>
        ${cats.length || negCount ? `<div class="chips" style="margin-top:8px"><span class="chip ${!itemsFilter.cat ? 'on' : ''}" data-cat="">Все</span>${negCount ? `<span class="chip ${itemsFilter.cat === '__neg' ? 'on' : ''}" data-cat="__neg">⚠️ В минусе (${negCount})</span>` : ''}${cats.map(c => `<span class="chip ${itemsFilter.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="row" style="margin-bottom:10px"><button class="btn primary grow" id="add">➕ Добавить</button><button class="btn grow" id="imp">⬆️ Импорт Excel</button></div>
      <div class="list" id="list"></div>`;
    const draw = () => {
      let list = items;
      if (itemsFilter.cat === '__neg') list = list.filter(i => (+i.qty || 0) < 0);
      else if (itemsFilter.cat) list = list.filter(i => i.category === itemsFilter.cat);
      if (itemsFilter.q) list = list.map(i => ({ i, s: Recog.textScore(itemsFilter.q, i) + (Recog.norm(i.name).includes(Recog.norm(itemsFilter.q)) ? 1 : 0) })).filter(x => x.s > 0.2).sort((a, b) => b.s - a.s).map(x => x.i);
      $('#list').innerHTML = list.length ? list.slice(0, 300).map(itemRow).join('') + (list.length > 300 ? `<p class="muted small">Показаны первые 300 из ${list.length}. Уточните поиск.</p>` : '')
        : `<div class="empty"><div class="big">📦</div>${items.length ? 'Ничего не найдено' : 'Каталог пуст. Добавьте товары или загрузите Excel.'}</div>`;
      bindItemRows($('#list'));
    };
    $('#q').oninput = e => { itemsFilter.q = e.target.value; draw(); };
    $('#qVoice').onclick = () => voiceInput(t => { itemsFilter.q = t; $('#q').value = t; draw(); });
    $('#qScan').onclick = () => quickScan(code => { const it = findCode(code); if (it) editItem(it); else { itemsFilter.q = code; $('#q').value = code; draw(); toast('Не найден: ' + code); } });
    $$('.chip[data-cat]').forEach(c => c.onclick = () => { itemsFilter.cat = c.dataset.cat; renderItems(); });
    $('#add').onclick = () => editItem();
    $('#imp').onclick = doImport;
    draw();
  }

  function editItem(it, opts = {}) {
    const { _after, _photoFile, ...fields } = opts;
    const preset = { _after, _photoFile };
    const isNew = !it;
    it = it ? JSON.parse(JSON.stringify(it)) : { id: DB.uid(), name: '', sku: '', barcode: '', category: '', location: S.loc || '', unit: 'шт', price: 0, qty: 0, minQty: 0, notes: '', photos: [], emb: [], createdAt: Date.now(), ...fields };
    it.photos = it.photos || []; it.emb = it.emb || [];
    const cats = categories();
    modal(isNew ? 'Новый товар' : 'Товар', `
      <label class="field"><span>Наименование *</span><div class="row"><input type="text" id="fName" value="${esc(it.name)}"><button class="btn" id="fVoice">🎤</button></div></label>
      <div class="grid two">
        <label class="field"><span>Артикул</span><input type="text" id="fSku" value="${esc(it.sku)}"></label>
        <label class="field"><span>Код (Saby)</span><input type="text" id="fCode" value="${esc(it.code || '')}"></label>
        <label class="field"><span>Штрихкод</span><div class="row"><input type="text" inputmode="numeric" id="fBar" value="${esc(it.barcode)}"><button class="btn" id="fScan">▦</button></div></label>
        <label class="field"><span>Категория</span><input type="text" id="fCat" list="catList" value="${esc(it.category)}"><datalist id="catList">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label class="field"><span>Место / ячейка</span><input type="text" id="fLoc" list="locList" value="${esc(it.location)}"><datalist id="locList">${S.locations.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label class="field"><span>Количество по учёту</span><input type="number" inputmode="decimal" id="fQty" value="${it.qty ?? 0}"></label>
        <label class="field"><span>Ед. изм.</span><input type="text" id="fUnit" value="${esc(it.unit)}"></label>
        <label class="field"><span>Цена, ₽</span><input type="number" inputmode="decimal" id="fPrice" value="${it.price ?? 0}"></label>
        <label class="field"><span>Мин. остаток</span><input type="number" inputmode="decimal" id="fMin" value="${it.minQty ?? 0}"></label>
      </div>
      <label class="field"><span>Примечание</span><textarea id="fNotes">${esc(it.notes)}</textarea></label>
      <div class="field"><span class="small muted">Фото (по ним приложение узнаёт товар — 2–3 ракурса лучше одного)</span>
        <div class="photos" id="fPhotos" style="margin-top:6px"></div>
        <div class="row" style="margin-top:8px"><button class="btn grow" id="fCam">📷 Сфотографировать</button><button class="btn grow" id="fGal">🖼️ Из галереи</button></div>
        <div class="small muted" id="fEmb" style="margin-top:6px"></div></div>
      <div class="row" style="margin-top:14px">
        ${isNew ? '' : '<button class="btn danger" id="fDel">🗑️</button><button class="btn" id="fLabel">🏷️</button>'}
        <button class="btn primary grow" id="fSave">Сохранить</button></div>`, b => {
      const drawPhotos = () => {
        $('#fPhotos', b).innerHTML = it.photos.map((p, i) => `<div class="ph"><img src="${safeImg(p)}" alt=""><button data-i="${i}" aria-label="Удалить">✕</button></div>`).join('') || '<span class="small muted">Нет фото</span>';
        $$('#fPhotos button', b).forEach(x => x.onclick = () => { const i = +x.dataset.i; it.photos.splice(i, 1); it.emb.splice(i, 1); drawPhotos(); });
        $('#fEmb', b).textContent = it.photos.length ? (it.emb.filter(Boolean).length === it.photos.length ? '✅ Распознавание по фото обучено' : '⏳ Фото ещё не обработаны нейросетью') : '';
      };
      const addPhotos = async files => {
        for (const f of [].concat(files || [])) {
          const img = await Recog.fileToImage(f);
          const url = Recog.toDataURL(img, 480, 0.75);
          it.photos.push(url); it.emb.push(null); drawPhotos();
          if (!it.barcode) { const code = await Recog.barcodeFromFile(f); if (code) { it.barcode = code; $('#fBar', b).value = code; toast('Штрихкод найден на фото: ' + code); } }
          if (S.visual) {
            try { if (!Recog.modelReady()) toast('Загружаю нейросеть (один раз)…', 4000); it.emb[it.photos.length - 1] = await Recog.embed(url); drawPhotos(); }
            catch (e) { toast('Нейросеть недоступна: ' + e.message); }
          }
        }
      };
      drawPhotos();
      $('#fVoice', b).onclick = () => voiceInput(t => { $('#fName', b).value = t; });
      $('#fScan', b).onclick = () => quickScan(code => { $('#fBar', b).value = code; }, true);
      $('#fCam', b).onclick = async () => addPhotos(await pickFile('image/*', { capture: true }));
      $('#fGal', b).onclick = async () => addPhotos(await pickFile('image/*', { multiple: true }));
      $('#fSave', b).onclick = async () => {
        const name = $('#fName', b).value.trim();
        if (!name) return toast('Введите наименование');
        const bar = $('#fBar', b).value.trim();
        const dup = bar && items.find(x => x.barcode === bar && x.id !== it.id);
        if (dup) return toast('Этот штрихкод уже у товара «' + dup.name + '»');
        Object.assign(it, {
          name, sku: $('#fSku', b).value.trim(), code: $('#fCode', b).value.trim(), barcode: bar, category: $('#fCat', b).value.trim(), location: $('#fLoc', b).value.trim(),
          qty: +$('#fQty', b).value || 0, unit: $('#fUnit', b).value.trim() || 'шт', price: +$('#fPrice', b).value || 0, minQty: +$('#fMin', b).value || 0, notes: $('#fNotes', b).value
        });
        if (it.location && !S.locations.includes(it.location)) { S.locations.push(it.location); saveS(); }
        await saveItem(it);
        items.sort((a, c) => a.name.localeCompare(c.name, 'ru'));
        closeModal(); toast('Сохранено'); if (preset._after) preset._after(it); else route();
      };
      if (!isNew) {
        $('#fDel', b).onclick = async () => { if (await confirmBox('Удалить товар «' + it.name + '»?', 'Удалить')) { await DB.del('items', it.id); items = items.filter(x => x.id !== it.id); toast('Удалено'); route(); } };
        $('#fLabel', b).onclick = () => { closeModal(); location.hash = 'labels/' + it.id; };
      }
      if (preset._photoFile) addPhotos(preset._photoFile);
    });
  }

  // ---------- быстрый скан в модальном окне ----------
  async function quickScan(onCode, keepModal) {
    const prev = keepModal ? { title: $('#modalTitle').textContent, body: $('#modalBody') } : null;
    let holder;
    if (keepModal) {
      holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.85);display:flex;flex-direction:column;justify-content:center;padding:16px';
      holder.innerHTML = '<div id="qsReader" style="width:100%;max-width:520px;margin:0 auto"></div><button class="btn block" style="max-width:520px;margin:12px auto 0" id="qsClose">Закрыть</button>';
      document.body.appendChild(holder);
    } else {
      modal('Сканирование', '<div id="qsReader"></div>');
    }
    const h = new Html5Qrcode('qsReader', { experimentalFeatures: { useBarCodeDetectorIfSupported: true }, verbose: false });
    let done = false;
    const finish = async code => {
      if (done) return; done = true;
      try { await h.stop(); } catch { }
      if (holder) holder.remove(); else closeModal();
      if (code) { feedback(true); onCode(code); }
    };
    if (holder) $('#qsClose', holder).onclick = () => finish(null);
    else onModalClose = () => { if (!done) { done = true; h.stop().catch(() => { }); } };
    try { await h.start({ facingMode: 'environment' }, { fps: 12, qrbox: (w, hh) => ({ width: Math.min(300, w * 0.85), height: Math.min(180, hh * 0.6) }) }, t => finish(t), () => { }); }
    catch (e) { toast('Камера недоступна: ' + (e.message || e)); finish(null); }
    void prev;
  }

  // ---------- ревизия ----------
  function progress() {
    const total = session.scope === 'counted' ? Object.keys(session.counts).length : items.length;
    const done = Object.keys(session.counts).length;
    const ms = (session.finishedAt || Date.now()) - session.startedAt - (session.pausedMs || 0);
    const min = Math.max(ms / 60000, 0.01);
    const scans = (session.log || []).length;
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    const left = done ? Math.max(total - done, 0) / (done / min) : 0;
    return {
      total, done, pct: total ? Math.min(100, Math.round(done / total * 100)) : 0,
      elapsed: `${h ? h + ' ч ' : ''}${m} мин ${String(s).padStart(2, '0')} с`,
      speed: `${Math.round(scans / min * 60)} действий/час`,
      eta: done && left > 0 ? `осталось ≈ ${left < 60 ? Math.round(left) + ' мин' : (left / 60).toFixed(1) + ' ч'}` : ''
    };
  }
  async function startSession(name, scope) {
    session = { id: DB.uid(), name, scope, startedAt: Date.now(), counts: {}, unknown: [], log: [] };
    await saveSession(); await DB.kvSet('activeSession', session.id);
  }
  async function addCount(itemId, delta, method, setTo) {
    const it = byId(itemId); if (!it) return;
    const first = !session.counts[itemId];
    const c = session.counts[itemId] || (session.counts[itemId] = { qty: 0, locs: {} });
    const loc = S.loc || '—';
    if (first && (+it.qty || 0) < 0) {
      const p = IO.negativeSuspects([it, ...items.filter(o => o.id !== it.id)])[0];
      toast(`⚠️ В учёте минус (${fmt(it.qty)}). ${p && p.partners.length ? 'Проверьте пересорт с: ' + p.partners.map(o => o.name).join(', ') : 'Вероятен пересорт или непроведённый приход.'}`, 5000);
    }
    const d = setTo !== undefined ? setTo - c.qty : delta;
    c.qty = Math.max(0, +(c.qty + d).toFixed(3));
    c.locs[loc] = Math.max(0, +((c.locs[loc] || 0) + d).toFixed(3));
    c.t = Date.now();
    session.log.push({ t: Date.now(), id: itemId, d, m: method, loc });
    lastItemId = itemId;
    await saveSession();
    drawLast(); drawProgress();
  }
  async function undo() {
    const l = session.log.pop(); if (!l) return toast('Нечего отменять');
    if (l.id === '?unknown') { session.unknown.pop(); }
    else {
      const c = session.counts[l.id];
      if (c) { c.qty = Math.max(0, +(c.qty - l.d).toFixed(3)); if (c.locs[l.loc] !== undefined) c.locs[l.loc] = Math.max(0, +(c.locs[l.loc] - l.d).toFixed(3)); if (c.qty === 0 && !session.log.some(x => x.id === l.id)) delete session.counts[l.id]; }
      lastItemId = l.id;
    }
    await saveSession(); drawLast(); drawProgress(); toast('Отменено');
  }

  async function renderCount() {
    if (!session) {
      view.innerHTML = `
        <div class="card"><h2>Новая ревизия</h2>
          <label class="field"><span>Название</span><input type="text" id="sName" value="Ревизия ${new Date().toLocaleDateString('ru-RU')}"></label>
          <label class="field"><span>Что сравниваем</span><select id="sScope">
            <option value="all">Весь каталог (что не посчитано — недостача)</option>
            <option value="counted">Только посчитанное (частичная ревизия зоны)</option></select></label>
          <p class="small muted">В каталоге ${items.length} товаров. ${items.length ? '' : 'Можно начинать и с пустым каталогом — неизвестные штрихкоды можно сразу завести как новые товары.'}</p>
          <button class="btn primary block" id="sGo">▶️ Начать подсчёт</button></div>
        <div class="card small muted">Совет: для ускорения включите «Каждый скан = +1» (Ещё → Настройки) и считайте одинаковые товары пиком сканера подряд.</div>`;
      $('#sGo').onclick = async () => { await startSession($('#sName').value.trim() || 'Ревизия', $('#sScope').value); renderCount(); };
      return;
    }
    view.innerHTML = `
      <div class="card" style="padding:10px 12px">
        <div class="row between small"><b class="grow" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(session.name)}</b><span id="pTime" class="muted"></span></div>
        <div class="progress" style="margin:8px 0"><i id="pBar"></i></div>
        <div class="small muted" id="pText"></div>
      </div>
      <div class="row" style="margin-bottom:10px">
        <span class="small muted">Зона:</span>
        <select id="locSel" class="grow">${S.locations.map(l => `<option ${l === S.loc ? 'selected' : ''}>${esc(l)}</option>`).join('')}<option value="__new">+ новая зона…</option></select>
      </div>
      <div class="seg" id="modeSeg">
        <button data-m="scan">▦ Сканер</button><button data-m="photo">📷 Фото</button><button data-m="search">🔎 Поиск</button>
      </div>
      <div id="modeBox"></div>
      <div class="card" id="lastCard" style="margin-top:12px"></div>
      <div class="row" style="margin-top:4px">
        <button class="btn grow" id="undoBtn">↩️ Отменить</button>
        <a class="btn grow" href="#report/${session.id}">📊 Отчёт</a>
        <button class="btn primary grow" id="finishBtn">✅ Завершить</button>
      </div>`;
    $('#locSel').onchange = async e => {
      if (e.target.value === '__new') {
        const n = prompt('Название зоны (стеллаж, комната, ячейка):');
        if (n && n.trim()) { S.locations.push(n.trim()); S.loc = n.trim(); } await saveS(); renderCount(); return;
      }
      S.loc = e.target.value; saveS();
    };
    $$('#modeSeg button').forEach(bt => bt.onclick = () => { countMode = bt.dataset.m; drawMode(); });
    $('#undoBtn').onclick = undo;
    $('#finishBtn').onclick = async () => {
      if (!(await confirmBox('Завершить ревизию и сформировать отчёт? Продолжить подсчёт потом будет нельзя.', 'Завершить'))) return;
      session.finishedAt = Date.now(); await saveSession(); await DB.kvSet('activeSession', null);
      const id = session.id; session = null; location.hash = 'report/' + id;
    };
    drawMode(); drawLast(); drawProgress();
    tick = setInterval(drawProgress, 1000);
  }
  function drawProgress() {
    if (!session || !$('#pBar')) return;
    const p = progress();
    $('#pBar').style.width = p.pct + '%';
    $('#pTime').textContent = '⏱ ' + p.elapsed;
    $('#pText').textContent = `Посчитано ${p.done} из ${p.total} (${p.pct}%) · ${p.speed}${p.eta ? ' · ' + p.eta : ''}${session.unknown.length ? ' · неизвестных: ' + session.unknown.length : ''}`;
  }
  function drawLast() {
    const box = $('#lastCard'); if (!box) return;
    const it = lastItemId && byId(lastItemId);
    if (!it) { box.innerHTML = '<div class="muted small" style="text-align:center">Отсканируйте товар — он появится здесь</div>'; return; }
    const c = session.counts[it.id] || { qty: 0 };
    const diff = c.qty - (+it.qty || 0);
    box.innerHTML = `
      <div class="last">${thumb(it)}<div class="grow"><div style="font-weight:700">${esc(it.name)}</div>
        <div class="small muted">${esc([it.sku, it.barcode].filter(Boolean).join(' · '))}</div>
        <div class="small">Учёт: ${fmt(it.qty)} ${esc(it.unit || '')} · <span class="${diff < 0 ? 'diff-neg' : diff > 0 ? 'diff-pos' : ''}">разница ${diff > 0 ? '+' : ''}${fmt(diff)}</span></div></div>
        <div class="bignum" id="bigN">${fmt(c.qty)}</div></div>
      <div class="counter">
        <button class="btn" data-d="-1">−1</button><button class="btn" data-d="1">+1</button>
        <button class="btn" data-d="5">+5</button><button class="btn" data-d="10">+10</button>
      </div>
      <div class="row" style="margin-top:8px"><button class="btn grow" id="lSet">🔢 Ввести итог</button><button class="btn grow" id="lEdit">✏️ Карточка</button></div>`;
    $$('#lastCard [data-d]').forEach(bt => bt.onclick = () => addCount(it.id, +bt.dataset.d, 'кнопка'));
    $('#lSet').onclick = () => qtySheet(it, null);
    $('#lEdit').onclick = () => editItem(it, { _after: () => drawLast() });
  }
  async function drawMode() {
    $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === countMode));
    const box = $('#modeBox');
    await stopScanner();
    if (countMode === 'scan') {
      box.innerHTML = `<div class="scanbox"><div id="reader"></div></div>
        <div class="row" style="margin-top:8px"><input type="text" inputmode="numeric" id="manualCode" placeholder="или введите штрихкод / артикул" class="grow"><button class="btn" id="manualGo">OK</button></div>
        <div class="small muted" style="margin-top:4px">${S.plusOne ? 'Каждый скан = +1' : 'После скана спрошу количество'} · работает и с Bluetooth-сканером (ввод в поле + Enter)</div>`;
      const go = () => { const v = $('#manualCode').value.trim(); if (v) { handleCode(v, 'ввод'); $('#manualCode').value = ''; } };
      $('#manualGo').onclick = go;
      $('#manualCode').onkeydown = e => { if (e.key === 'Enter') go(); };
      startScanner();
    } else if (countMode === 'photo') {
      box.innerHTML = `<button class="btn primary block" id="phShot" style="min-height:120px;font-size:18px">📷 Сфотографировать товар</button>
        <div class="row" style="margin-top:8px"><button class="btn grow" id="phGal">🖼️ Из галереи</button></div>
        <p class="small muted">Ищу штрихкод на снимке, сравниваю с фото товаров в каталоге${S.apiKey ? ', спрашиваю ИИ Claude' : ''}. Чем больше у товаров фото — тем точнее.</p>`;
      $('#phShot').onclick = async () => { const f = await pickFile('image/*', { capture: true }); if (f) photoFlow({ file: f, countIt: true }); };
      $('#phGal').onclick = async () => { const f = await pickFile('image/*'); if (f) photoFlow({ file: f, countIt: true }); };
    } else {
      box.innerHTML = `<div class="row"><input type="search" id="cq" placeholder="Название, артикул…" class="grow"><button class="btn" id="cqV">🎤</button></div><div class="list" id="cqList" style="margin-top:8px"></div>`;
      const draw = () => {
        const q = $('#cq').value;
        let list, head = '';
        if (q) list = Recog.textMatch(q, items, 30).map(x => x.item).concat(items.filter(i => Recog.norm(i.name).includes(Recog.norm(q)))).filter((v, i, a) => a.indexOf(v) === i).slice(0, 30);
        else {
          // сначала минусовые и похожие на них (кандидаты на пересорт), потом остальные непосчитанные
          const pri = [];
          for (const x of IO.negativeSuspects(items)) pri.push(x.neg, ...x.partners);
          const pr = [...new Set(pri)].filter(i => !session.counts[i.id]);
          list = pr.concat(items.filter(i => !session.counts[i.id] && !pr.includes(i))).slice(0, 40);
          head = pr.length ? `<div class="small diff-neg">⚠️ Сначала: минусовые и похожие на них (${pr.length})</div>` : '<div class="small muted">Ещё не посчитаны:</div>';
        }
        $('#cqList').innerHTML = head + list.map(itemRow).join('');
        $$('#cqList .item').forEach(el => el.onclick = () => qtySheet(byId(el.dataset.id), 'поиск'));
      };
      $('#cq').oninput = draw;
      $('#cqV').onclick = () => voiceInput(t => { $('#cq').value = t; draw(); });
      draw();
    }
  }
  async function startScanner() {
    if (!window.Html5Qrcode) { setTimeout(startScanner, 400); return; }
    if (!$('#reader')) return;
    scanner = new Html5Qrcode('reader', { experimentalFeatures: { useBarCodeDetectorIfSupported: true }, verbose: false });
    try {
      await scanner.start({ facingMode: 'environment' }, { fps: 12, qrbox: (w, h) => ({ width: Math.min(320, w * 0.85), height: Math.min(180, h * 0.6) }) },
        code => { const now = Date.now(); if (code === lastCode.code && now - lastCode.t < 1500) return; lastCode = { code, t: now }; handleCode(code, 'скан'); }, () => { });
    } catch (e) {
      $('#reader').innerHTML = `<div class="empty" style="color:#ddd">Камера недоступна (${esc(e.message || e)}).<br>Разрешите доступ к камере или введите код вручную.</div>`;
      scanner = null;
    }
  }
  async function stopScanner() {
    if (scanner) { const s = scanner; scanner = null; try { await s.stop(); s.clear(); } catch { } }
  }
  function handleCode(code, method) {
    const it = findCode(code);
    if (it) {
      feedback(true);
      if (S.plusOne) addCount(it.id, 1, method); else { lastItemId = it.id; drawLast(); qtySheet(it, method); }
      return;
    }
    feedback(false);
    if (scanner) scanner.pause(true);
    const resume = () => { if (scanner) try { scanner.resume(); } catch { } };
    modal('Не найден в каталоге', `<p>Код <span class="kbd">${esc(code)}</span> отсутствует в каталоге.</p>
      <div class="grid"><button class="btn primary" id="uNew">➕ Создать товар с этим кодом</button>
      <button class="btn" id="uPhoto">📷 Сфотографировать и определить</button>
      <button class="btn" id="uBind">🔗 Привязать код к существующему товару</button>
      <button class="btn" id="uSkip">📝 Записать как неизвестный (+1)</button></div>`, b => {
      onModalClose = resume;
      $('#uNew', b).onclick = () => { onModalClose = null; editItem(null, { barcode: code, _after: async it => { await addCount(it.id, 1, method); resume(); } }); };
      $('#uPhoto', b).onclick = async () => { onModalClose = null; closeModal(); const f = await pickFile('image/*', { capture: true }); if (f) photoFlow({ file: f, countIt: true, code }); resume(); };
      $('#uBind', b).onclick = () => { onModalClose = null; pickItem('Какому товару принадлежит код?', async it => { it.barcode = code; await saveItem(it); await addCount(it.id, 1, method); toast('Код привязан'); resume(); }); };
      $('#uSkip', b).onclick = async () => { session.unknown.push({ code, qty: 1, loc: S.loc }); session.log.push({ t: Date.now(), id: '?unknown', d: 1, m: method, loc: S.loc }); await saveSession(); closeModal(); drawProgress(); toast('Записан как неизвестный'); };
    });
  }
  function sabyHelp() {
    modal('Работа с Saby', `<div class="small" style="line-height:1.55">
      <b>1. Остатки из Saby → в Ревизор</b>
      <ol style="padding-left:18px;margin:6px 0 12px">
        <li>В Saby откройте «Каталог» (в Saby Bu — «Склад/Каталог и цены»), отметьте разделы → «Выгрузить» → Excel.</li>
        <li>В «Отображение колонок» включите: код товара, артикул, штрихкод, остатки, цены → «Применить» → «Скачать».</li>
        <li>Здесь: «Ещё → Импорт Excel» и выберите этот файл. Колонки распознаются сами.</li>
      </ol>
      <b>2. Считаете в Ревизоре</b> — сканер, фото, поиск. Минусы и пересорт подсвечиваются.
      <br><br><b>3. Результат → в Saby</b>
      <ol style="padding-left:18px;margin:6px 0 12px">
        <li>В отчёте нажмите «Файл для Saby» (или 📤 — отправить себе на компьютер).</li>
        <li>В Saby: «Склад/Документы» → «+» → «Инвентаризации/Инвентаризация». Проверьте организацию и склад, дату и способ «по количеству».</li>
        <li>Вкладка со скрепкой → «Добавить/С компьютера» → файл → «Разобрать».</li>
        <li>В поле «Разбор начинать с» укажите строку <b>2</b>. Проверьте колонки: «Количество» должно стать фактическим количеством. «Не задано» данные не загрузит.</li>
        <li>«Загрузить» → сохраните шаблон (в следующий раз всё подставится само) → проверьте отклонения (красные — недостача, зелёные — излишки) → «Провести».</li>
      </ol>
      <p class="muted">Пересорт перед проведением лучше оформить в Saby отдельно, по листу «Пересорт» из отчёта Excel.</p></div>`);
  }
  function pickItem(title, onPick) {
    modal(title, `<input type="search" id="pq" placeholder="Поиск"><div class="list" id="pl" style="margin-top:8px"></div>`, b => {
      const draw = () => {
        const q = $('#pq', b).value;
        const list = q ? items.filter(i => Recog.textScore(q, i) > 0.2 || Recog.norm(i.name).includes(Recog.norm(q))).slice(0, 40) : items.slice(0, 40);
        $('#pl', b).innerHTML = list.map(itemRow).join('') || '<div class="empty">Нет товаров</div>';
        $$('#pl .item', b).forEach(el => el.onclick = () => { closeModal(); onPick(byId(el.dataset.id)); });
      };
      $('#pq', b).oninput = draw; draw(); $('#pq', b).focus();
    });
  }
  function qtySheet(it, method, suggest) {
    if (!session) return editItem(it);
    const c = session.counts[it.id] || { qty: 0 };
    modal(it.name, `
      <div class="last">${thumb(it)}<div class="grow small">Учёт: <b>${fmt(it.qty)}</b> ${esc(it.unit || '')}<br>Уже посчитано: <b>${fmt(c.qty)}</b></div></div>
      <label class="field" style="margin-top:12px"><span>Количество</span><input type="number" inputmode="decimal" id="qN" value="${suggest || 1}" style="font-size:24px;text-align:center"></label>
      <div class="chips">${[1, 2, 3, 5, 6, 10, 12, 20, 24, 50, 100].map(n => `<span class="chip" data-n="${n}">${n}</span>`).join('')}<span class="chip" id="qVoice">🎤</span></div>
      <div class="row" style="margin-top:12px"><button class="btn grow" id="qSet">= Итог</button><button class="btn primary grow" id="qAdd">+ Добавить</button></div>`, b => {
      const inp = $('#qN', b); inp.select();
      $$('[data-n]', b).forEach(x => x.onclick = () => { inp.value = x.dataset.n; });
      $('#qVoice', b).onclick = () => voiceInput(t => { const m = t.replace(',', '.').match(/\d+(\.\d+)?/); if (m) inp.value = m[0]; else toast('Не понял число: ' + t); });
      $('#qAdd', b).onclick = async () => { closeModal(); await addCount(it.id, +inp.value || 0, method || 'ввод'); };
      $('#qSet', b).onclick = async () => { closeModal(); await addCount(it.id, 0, method || 'ввод', +inp.value || 0); };
      inp.onkeydown = e => { if (e.key === 'Enter') $('#qAdd', b).click(); };
    });
  }

  // ---------- распознавание по фото ----------
  async function photoFlow({ file, countIt, code } = {}) {
    if (!file) { file = await pickFile('image/*', { capture: true }); if (!file) return; }
    const img = await Recog.fileToImage(file);
    const shot = Recog.toDataURL(img, 1024, 0.82);
    const small = Recog.toDataURL(img, 480, 0.75);
    let cands = []; let ai = null; let emb = null;
    const merge = (arr, why) => { for (const x of arr) { const e = cands.find(c => c.item.id === x.item.id); if (e) { e.score = Math.max(e.score, x.score); if (!e.why.includes(why)) e.why += ', ' + why; } else cands.push({ ...x, why }); } cands.sort((a, b) => b.score - a.score); };
    const render = (status = '') => {
      const b = $('#modalBody'); if (!b || !$('#prImg', b)) return;
      $('#prStatus', b).textContent = status;
      $('#prList', b).innerHTML = cands.length ? cands.slice(0, 6).map(c => `<div class="cand" data-id="${c.item.id}">${thumb(c.item)}<div class="grow"><b>${esc(c.item.name)}</b><div class="small muted">${esc(c.why)} · ${Math.round(c.score * 100)}%</div></div><span>›</span></div>`).join('')
        : (status ? '' : '<div class="muted small">Совпадений в каталоге не найдено.</div>');
      $$('#prList .cand', b).forEach(el => el.onclick = () => choose(byId(el.dataset.id)));
      $('#prAi', b).innerHTML = ai ? `<div class="card small" style="margin:8px 0"><b>ИИ:</b> ${esc(ai.name)}${ai.brand ? ' (' + esc(ai.brand) + ')' : ''}${ai.category ? ' · ' + esc(ai.category) : ''}${ai.count_visible > 1 ? ` · на фото ${ai.count_visible} шт.` : ''}${ai.label_text ? `<div class="muted">«${esc(ai.label_text.slice(0, 120))}»</div>` : ''}</div>` : '';
    };
    const choose = async it => {
      const learn = $('#prLearn') && $('#prLearn').checked;
      closeModal();
      if (learn) { it.photos.push(small); if (!emb && S.visual) { try { emb = await Recog.embed(small); } catch { } } it.emb.push(emb || null); }
      if (code && !it.barcode) it.barcode = code;
      if (learn || code) await saveItem(it);
      if (countIt && session) { lastItemId = it.id; drawLast(); qtySheet(it, 'фото', ai && ai.count_visible > 1 ? ai.count_visible : 1); }
      else editItem(it);
    };
    modal('Распознавание', `
      <img id="prImg" src="${small}" alt="" style="width:100%;max-height:220px;object-fit:contain;border-radius:12px;background:var(--surface2)">
      <div class="small muted" id="prStatus" style="margin:8px 0"></div>
      <div id="prAi"></div>
      <div id="prList"></div>
      <label class="row small" style="margin:8px 0"><input type="checkbox" id="prLearn" checked> Запомнить это фото у товара (точнее в следующий раз)</label>
      <div class="grid two">
        <button class="btn" id="prAskAi">🤖 Спросить ИИ</button>
        <button class="btn" id="prOcr">🔤 Прочитать текст</button>
        <button class="btn" id="prPick">🔎 Выбрать вручную</button>
        <button class="btn primary" id="prNew">➕ Новый товар</button>
      </div>`, b => {
      $('#prPick', b).onclick = () => pickItem('Выберите товар', it => choose(it));
      $('#prNew', b).onclick = () => {
        closeModal();
        editItem(null, {
          name: ai ? ai.name : '', category: ai ? ai.category : '', barcode: code || (ai && /^\d{8,14}$/.test(ai.barcode) ? ai.barcode : ''),
          photos: [small], emb: [emb], notes: ai && ai.label_text ? ai.label_text.slice(0, 200) : '',
          _after: async it => { if (countIt && session) { lastItemId = it.id; qtySheet(it, 'фото', ai && ai.count_visible > 1 ? ai.count_visible : 1); } }
        });
      };
      const runAi = async () => {
        if (!S.apiKey) { toast('Добавьте API-ключ Claude: Ещё → Настройки'); return; }
        render('🤖 Спрашиваю ИИ…');
        try {
          ai = await Recog.askClaude(shot, items, S);
          if (ai.match_id && byId(ai.match_id)) merge([{ item: byId(ai.match_id), score: Math.max(0.6, Math.min(0.99, ai.confidence || 0.8)) }], 'ИИ');
          else if (ai.name) merge(Recog.textMatch(ai.name + ' ' + (ai.brand || '') + ' ' + (ai.label_text || ''), items, 3), 'ИИ по названию');
          if (ai.barcode) { const it = findCode(ai.barcode); if (it) merge([{ item: it, score: 1 }], 'штрихкод (ИИ)'); }
          render('');
        } catch (e) { render(''); toast(e.message, 4000); }
      };
      $('#prAskAi', b).onclick = runAi;
      $('#prOcr', b).onclick = async () => {
        render('🔤 Читаю текст на этикетке… (первый раз грузится ~10 МБ)');
        try {
          const txt = await Recog.ocr(file, m => render(`🔤 ${m.status} ${Math.round(m.progress * 100)}%`));
          const digits = (txt.replace(/\s/g, '').match(/\d{8,14}/g) || []);
          for (const d of digits) { const it = findCode(d); if (it) merge([{ item: it, score: 0.97 }], 'штрихкод (текст)'); }
          merge(Recog.textMatch(txt, items, 5), 'текст этикетки');
          render(cands.length ? '' : 'Текст: ' + txt.slice(0, 120));
        } catch (e) { render(''); toast('OCR: ' + e.message); }
      };
      (async () => {
        render('▦ Ищу штрихкод…');
        const bc = await Recog.barcodeFromFile(file);
        if (bc) { const it = findCode(bc); if (it) merge([{ item: it, score: 1 }], 'штрихкод'); else if (!code) code = bc; }
        const hasEmb = items.some(i => i.emb && i.emb.some(Boolean));
        if (S.visual && hasEmb) {
          render(Recog.modelReady() ? '🧠 Сравниваю с фото каталога…' : '🧠 Загружаю нейросеть (один раз)…');
          try { emb = await Recog.embed(small); merge(Recog.visualMatch(emb, items.map(i => ({ ...i, emb: (i.emb || []).filter(Boolean) })), 5).filter(x => x.score > 0.55), 'похоже по фото'); }
          catch (e) { toast('Нейросеть: ' + e.message); }
        }
        if (S.apiKey && S.aiAuto && !(cands[0] && cands[0].score >= 0.97)) await runAi();
        else render(bc && !findCode(bc) ? 'Найден штрихкод ' + bc + ', но его нет в каталоге' : '');
        if (cands[0] && cands[0].score >= 0.999 && countIt && session) choose(cands[0].item);
      })();
    });
  }

  // ---------- отчёт ----------
  async function renderReport(id) {
    const s = id ? await DB.get('sessions', id) : session;
    if (!s) { view.innerHTML = '<div class="empty">Ревизия не найдена</div>'; return; }
    const { rows, totals } = IO.sessionRows(s, items);
    const rg = IO.regrade(rows);
    const shortSum = rows.filter(r => r.diff < 0).reduce((a, r) => a - r.diff * r.price, 0);
    const negRows = rows.filter(r => r.book < 0);
    let filter = 'diff';
    view.innerHTML = `
      <div class="card"><b>${esc(s.name)}</b><div class="small muted">${new Date(s.startedAt).toLocaleString('ru-RU')}${s.finishedAt ? ' — ' + new Date(s.finishedAt).toLocaleString('ru-RU') : ' · идёт'}</div></div>
      <div class="grid three">
        <div class="stat"><b class="diff-pos">${totals.matched}</b><span>совпало</span></div>
        <div class="stat"><b class="diff-neg">${totals.short}</b><span>недостача</span></div>
        <div class="stat"><b>${totals.extra}</b><span>излишек</span></div>
      </div>
      <div class="card" style="margin-top:10px"><div class="row between"><span>Сумма расхождения</span><b class="${totals.sumDiff < 0 ? 'diff-neg' : 'diff-pos'}">${money(totals.sumDiff)}</b></div>
        <div class="row between small muted"><span>По учёту / факт</span><span>${money(totals.sumBook)} / ${money(totals.sumFact)}</span></div>
        <div class="row between small muted"><span>Недостача всего</span><span>${money(shortSum)}</span></div>
        ${rg.pairs.length ? `<div class="row between small"><span>Закрывается пересортом (${rg.pairs.length} пар)</span><b class="diff-pos">${money(rg.covered)}</b></div>
        <div class="row between small"><span>Реальная недостача после пересорта</span><b class="diff-neg">${money(shortSum - rg.covered)}</b></div>` : ''}
        ${negRows.length ? `<div class="small diff-neg" style="margin-top:6px">⚠️ В учёте было в минусе: ${negRows.length} товаров</div>` : ''}
        ${s.unknown && s.unknown.length ? `<div class="small" style="margin-top:6px">Неизвестных кодов: ${s.unknown.length}</div>` : ''}</div>
      <div class="row wrap noprint" style="margin:10px 0">
        <button class="btn primary grow" id="rX">⬇️ Excel</button><button class="btn grow" id="rShare">📤 Отправить</button><button class="btn grow" id="rPrint">🖨️ Печать</button>
      </div>
      <div class="row noprint" style="margin-bottom:10px"><button class="btn primary grow" id="rSaby">⬇️ Файл для Saby</button><button class="btn" id="rSabyS">📤</button><button class="btn" id="rSabyHelp">❓</button></div>
      ${s.finishedAt ? `<button class="btn block noprint" id="rApply" style="margin-bottom:10px">✔️ Принять факт как новые остатки</button>` : ''}
      <div class="seg noprint" id="rSeg"><button data-f="diff">Расхожд.</button><button data-f="regrade">Пересорт</button><button data-f="neg">Минусы</button><button data-f="none">Не счит.</button><button data-f="all">Все</button></div>
      <div class="card" style="padding:4px 8px;overflow-x:auto"><table class="rep"><thead id="rHead"></thead><tbody id="rBody"></tbody></table></div>`;
    const draw = () => {
      $$('#rSeg button').forEach(b => b.classList.toggle('on', b.dataset.f === filter));
      if (filter === 'regrade') {
        $('#rHead').innerHTML = '<tr><th>Недостача → Излишек</th><th class="n">Кол-во</th><th class="n">± ₽</th></tr>';
        $('#rBody').innerHTML = rg.pairs.map(p => `<tr><td><span class="diff-neg">− ${esc(p.short.name)}</span><br><span class="diff-pos">+ ${esc(p.extra.name)}</span><div class="small muted">схожесть ${Math.round(p.sim * 100)}%</div></td><td class="n">${fmt(p.qty)}</td><td class="n">${fmt(p.sumExtra - p.sumShort)}</td></tr>`).join('')
          || '<tr><td colspan="3" class="muted" style="text-align:center;padding:20px">Похожих пар «недостача ↔ излишек» не найдено</td></tr>';
        return;
      }
      $('#rHead').innerHTML = '<tr><th>Товар</th><th class="n">Учёт</th><th class="n">Факт</th><th class="n">±</th></tr>';
      const list = rows.filter(r => filter === 'all' || (filter === 'diff' ? r.diff !== 0 : filter === 'neg' ? r.book < 0 : !r.counted));
      $('#rBody').innerHTML = list.map(r => `<tr><td>${esc(r.it.name)}<div class="small muted">${esc(r.it.sku || r.it.barcode || '')}${r.locs ? ' · ' + esc(r.locs) : ''}</div></td><td class="n">${fmt(r.book)}</td><td class="n">${fmt(r.fact)}</td><td class="n ${r.diff < 0 ? 'diff-neg' : r.diff > 0 ? 'diff-pos' : ''}">${r.diff > 0 ? '+' : ''}${fmt(r.diff)}</td></tr>`).join('')
        || '<tr><td colspan="4" class="muted" style="text-align:center;padding:20px">Пусто</td></tr>';
    };
    $$('#rSeg button').forEach(b => b.onclick = () => { filter = b.dataset.f; draw(); });
    $('#rX').onclick = () => IO.exportReport(s);
    $('#rShare').onclick = () => IO.exportReport(s, true);
    $('#rPrint').onclick = () => { filter = 'all'; draw(); window.print(); };
    $('#rSaby').onclick = () => IO.exportSaby(s);
    $('#rSabyS').onclick = () => IO.exportSaby(s, true);
    $('#rSabyHelp').onclick = sabyHelp;
    const ap = $('#rApply');
    if (ap) ap.onclick = async () => {
      if (!(await confirmBox('Заменить количество «по учёту» на посчитанное? Непосчитанные товары станут 0 (если ревизия по всему каталогу).', 'Заменить'))) return;
      const upd = [];
      for (const r of rows) { r.it.qty = r.fact; r.it.updatedAt = Date.now(); upd.push(r.it); }
      await DB.putMany('items', upd); await reload(); toast('Остатки обновлены'); renderReport(id);
    };
    draw();
  }
  async function renderSessions() {
    const list = (await DB.all('sessions')).sort((a, b) => b.startedAt - a.startedAt);
    view.innerHTML = list.length ? `<div class="list">${list.map(s => `<div class="item" data-sid="${s.id}"><div class="thumb">📋</div><div class="grow"><div class="name">${esc(s.name)}</div><div class="meta">${new Date(s.startedAt).toLocaleString('ru-RU')} · позиций: ${Object.keys(s.counts).length}</div></div><span class="pill ${s.finishedAt ? '' : 'ok'}">${s.finishedAt ? 'завершена' : 'идёт'}</span></div>`).join('')}</div>
      <p class="small muted">Объединить подсчёт с нескольких телефонов: на каждом сделайте «Резервную копию», затем на главном телефоне «Ещё → Объединить подсчёт».</p>`
      : '<div class="empty"><div class="big">📋</div>Ревизий ещё не было</div>';
    $$('[data-sid]').forEach(el => el.onclick = () => { location.hash = 'report/' + el.dataset.sid; });
  }

  // ---------- файлы ----------
  async function renderFiles() {
    const files = (await DB.all('files')).sort((a, b) => b.t - a.t);
    const size = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.ceil(n / 1024) + ' КБ';
    const icon = f => /^image\//.test(f.type) ? '🖼️' : /sheet|excel|csv/.test(f.type + f.name) ? '📊' : /pdf/.test(f.type) ? '📄' : '📎';
    view.innerHTML = `
      <div class="dropzone" id="dz">Перетащите файлы сюда или<br><button class="btn primary" id="fAdd" style="margin-top:8px">📎 Выбрать файлы</button>
        <div class="small" style="margin-top:6px">Накладные, фото, PDF, Excel — всё хранится на телефоне</div></div>
      <h3>Файлы (${files.length})</h3>
      <div class="list">${files.map(f => `<div class="item" data-fid="${f.id}">${/^image\//.test(f.type) ? `<img class="thumb" data-img="${f.id}" alt="">` : `<div class="thumb">${icon(f)}</div>`}
        <div class="grow"><div class="name">${esc(f.name)}</div><div class="meta">${size(f.size)} · ${new Date(f.t).toLocaleString('ru-RU')}</div></div></div>`).join('') || '<div class="empty">Файлов пока нет</div>'}</div>`;
    const store = async list => {
      for (const f of list) await DB.put('files', { id: DB.uid(), name: f.name, type: f.type || 'application/octet-stream', size: f.size, t: Date.now(), blob: f });
      toast('Сохранено файлов: ' + list.length); renderFiles();
    };
    $('#fAdd').onclick = async () => { const l = await pickFile('*/*', { multiple: true }); if (l && l.length) store(l); };
    const dz = $('#dz');
    dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
    dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files.length) store(Array.from(e.dataTransfer.files)); };
    for (const f of files) { const im = $(`[data-img="${f.id}"]`); if (im) im.src = URL.createObjectURL(f.blob); }
    $$('[data-fid]').forEach(el => el.onclick = () => {
      const f = files.find(x => x.id === el.dataset.fid);
      const isSheet = /\.(xlsx|xls|csv)$/i.test(f.name);
      modal(f.name, `${/^image\//.test(f.type) ? `<img src="${URL.createObjectURL(f.blob)}" style="width:100%;border-radius:12px" alt="">` : ''}
        <div class="grid" style="margin-top:10px">
          <button class="btn primary" id="xDl">⬇️ Скачать</button>
          <button class="btn" id="xShare">📤 Отправить</button>
          <button class="btn" id="xOpen">👁️ Открыть</button>
          ${isSheet ? '<button class="btn" id="xImp">📦 Загрузить как каталог товаров</button>' : ''}
          ${/^image\//.test(f.type) ? '<button class="btn" id="xRec">🔍 Распознать товар на фото</button>' : ''}
          <button class="btn danger" id="xDel">🗑️ Удалить</button></div>`, b => {
        $('#xDl', b).onclick = () => IO.deliver(f.blob, f.name);
        $('#xShare', b).onclick = () => IO.deliver(f.blob, f.name, true);
        $('#xOpen', b).onclick = () => window.open(URL.createObjectURL(f.blob), '_blank');
        if (isSheet) $('#xImp', b).onclick = async () => { closeModal(); await runImport(new File([f.blob], f.name)); };
        if (/^image\//.test(f.type)) $('#xRec', b).onclick = () => { closeModal(); photoFlow({ file: new File([f.blob], f.name, { type: f.type }), countIt: !!session }); };
        $('#xDel', b).onclick = async () => { if (await confirmBox('Удалить файл «' + f.name + '»?', 'Удалить')) { await DB.del('files', f.id); renderFiles(); } };
      });
    });
  }

  // ---------- импорт ----------
  async function doImport() { const f = await pickFile('.xlsx,.xls,.csv,.ods,.txt'); if (f) runImport(f); }
  async function runImport(f) {
    try {
      toast('Читаю файл…');
      const r = await IO.importItems(f);
      await reload();
      toast(`Готово: новых ${r.added}, обновлено ${r.updated}`, 3500);
      route();
    } catch (e) { toast(e.message, 4500); }
  }

  // ---------- этикетки ----------
  async function renderLabels(id) {
    const list = id ? [byId(id)].filter(Boolean) : items;
    view.innerHTML = `<div class="noprint"><p class="small muted">QR-код содержит штрихкод/артикул товара — его понимает сканер приложения. ${list.length} шт.</p>
      <div class="row" style="margin-bottom:12px"><button class="btn primary grow" id="lPrint">🖨️ Печать / PDF</button><a class="btn" href="#items">Назад</a></div></div>
      <div id="labels" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px"></div>`;
    const box = $('#labels');
    const draw = () => {
      if (!window.qrcode) return setTimeout(draw, 300);
      box.innerHTML = list.slice(0, 500).map(it => {
        const qr = qrcode(0, 'M'); qr.addData(String(it.barcode || it.sku || it.id)); qr.make();
        return `<div style="border:1px dashed #999;border-radius:8px;padding:8px;text-align:center;background:#fff;color:#000;break-inside:avoid">
          <img src="${qr.createDataURL(4, 2)}" style="width:110px;height:110px" alt=""><div style="font-size:12px;font-weight:600;line-height:1.2">${esc(it.name)}</div>
          <div style="font-size:11px">${esc(it.sku || '')} ${it.price ? '· ' + money(it.price) : ''}</div></div>`;
      }).join('');
    };
    draw();
    $('#lPrint').onclick = () => window.print();
  }

  // ---------- ещё / настройки ----------
  async function renderMore() {
    const u = await DB.usage();
    view.innerHTML = `
      <h3>Saby</h3>
      <div class="card small"><p style="margin-top:0">Загрузка остатков из Saby и выгрузка результата обратно в документ «Инвентаризация».</p>
        <button class="btn block" id="mSaby">❓ Как работать с Saby</button></div>
      <h3>Каталог</h3>
      <div class="grid two">
        <button class="btn" id="mImp">⬆️ Импорт Excel / CSV</button><button class="btn" id="mTpl">📄 Шаблон Excel</button>
        <button class="btn" id="mXlsx">⬇️ Экспорт Excel</button><button class="btn" id="mCsv">⬇️ Экспорт CSV</button>
        <a class="btn" href="#labels">🏷️ Этикетки QR</a><a class="btn" href="#sessions">📋 История ревизий</a>
      </div>
      <h3>Резервная копия и несколько телефонов</h3>
      <div class="grid two">
        <button class="btn" id="mBak">💾 Сохранить копию</button><button class="btn" id="mBakS">📤 Отправить копию</button>
        <button class="btn" id="mRes">♻️ Восстановить</button><button class="btn" id="mMerge">🔀 Объединить подсчёт</button>
      </div>
      <h3>Распознавание</h3>
      <div class="card">
        <label class="row" style="margin-bottom:10px"><input type="checkbox" id="sVis" ${S.visual ? 'checked' : ''}> <span>Узнавать товар по фото (нейросеть на телефоне, без интернета после загрузки)</span></label>
        <button class="btn block" id="sTrain">🧠 Обучить по всем фото каталога</button>
        <div class="small muted" id="trainState" style="margin-top:6px"></div>
        <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
        <b>ИИ Claude</b> <span class="small muted">— определяет любой товар по фото, даже если его нет в каталоге</span>
        <label class="field" style="margin-top:8px"><span>API-ключ (хранится только на этом телефоне)</span><input type="password" id="sKey" value="${esc(S.apiKey)}" placeholder="sk-ant-…" autocomplete="off"></label>
        <label class="field"><span>Модель</span><select id="sModel">
          ${[['claude-opus-5-5', 'Claude Opus 5.5 — точнее всего'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 — быстрее и дешевле'], ['claude-haiku-5-5', 'Claude Haiku 5.5 — самый дешёвый']].map(([v, t]) => `<option value="${v}" ${S.model === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="row"><input type="checkbox" id="sAiAuto" ${S.aiAuto ? 'checked' : ''}> <span>Спрашивать ИИ автоматически при каждом фото</span></label>
        <p class="small muted">Ключ получают на console.anthropic.com. Фото отправляется в Anthropic только когда спрашиваете ИИ.</p>
      </div>
      <h3>Подсчёт</h3>
      <div class="card">
        <label class="row" style="margin-bottom:8px"><input type="checkbox" id="sPlus" ${S.plusOne ? 'checked' : ''}> <span>Каждый скан = +1 (иначе спрашивать количество)</span></label>
        <label class="row" style="margin-bottom:8px"><input type="checkbox" id="sBeep" ${S.beep ? 'checked' : ''}> <span>Звук при скане</span></label>
        <label class="row" style="margin-bottom:8px"><input type="checkbox" id="sVib" ${S.vibrate ? 'checked' : ''}> <span>Вибрация</span></label>
        <label class="field"><span>Зоны (через запятую)</span><input type="text" id="sLocs" value="${esc(S.locations.join(', '))}"></label>
        <label class="field"><span>Тема</span><select id="sTheme">${[['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([v, t]) => `<option value="${v}" ${S.theme === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <h3>Приложение</h3>
      <div class="card small">
        <p style="margin-top:0"><b>Установка на телефон:</b> Android/Chrome — меню ⋮ → «Установить приложение» (или кнопка «Установить» вверху). iPhone/Safari — «Поделиться» → «На экран Домой».</p>
        <p>Хранилище: ${u ? (u.usage / 1048576).toFixed(1) + ' МБ занято' : 'неизвестно'}. Данные только на этом устройстве — делайте резервные копии.</p>
        <button class="btn danger block" id="mWipe">🗑️ Удалить все данные</button>
      </div>`;
    $('#mImp').onclick = doImport;
    $('#mSaby').onclick = sabyHelp;
    $('#mTpl').onclick = () => IO.template();
    $('#mXlsx').onclick = () => IO.exportCatalog('xlsx');
    $('#mCsv').onclick = () => IO.exportCatalog('csv');
    $('#mBak').onclick = () => IO.backup();
    $('#mBakS').onclick = () => IO.backup(true);
    $('#mRes').onclick = async () => {
      const f = await pickFile('.json,application/json'); if (!f) return;
      const replace = await confirmBox('Заменить текущие данные копией? «Отмена» — добавить к текущим.', 'Заменить');
      try { const r = await IO.restore(f, replace); await reload(); toast(`Восстановлено: товаров ${r.items}, ревизий ${r.sessions}, файлов ${r.files}`, 3500); } catch (e) { toast(e.message, 4000); }
    };
    $('#mMerge').onclick = mergeCounts;
    const set = (k, v) => { S[k] = v; saveS(); };
    $('#sVis').onchange = e => set('visual', e.target.checked);
    $('#sKey').onchange = e => set('apiKey', e.target.value.trim());
    $('#sModel').onchange = e => set('model', e.target.value);
    $('#sAiAuto').onchange = e => set('aiAuto', e.target.checked);
    $('#sPlus').onchange = e => set('plusOne', e.target.checked);
    $('#sBeep').onchange = e => set('beep', e.target.checked);
    $('#sVib').onchange = e => set('vibrate', e.target.checked);
    $('#sLocs').onchange = e => { const l = e.target.value.split(',').map(x => x.trim()).filter(Boolean); set('locations', l.length ? l : ['Склад']); if (!S.locations.includes(S.loc)) set('loc', S.locations[0]); };
    $('#sTheme').onchange = e => { set('theme', e.target.value); applyTheme(); };
    $('#sTrain').onclick = async () => {
      const st = $('#trainState');
      const todo = items.filter(i => (i.photos || []).some((p, k) => !(i.emb || [])[k]));
      if (!todo.length) { st.textContent = 'Все фото уже обработаны ✅'; return; }
      st.textContent = 'Загружаю нейросеть…';
      try {
        let n = 0;
        for (const it of todo) {
          it.emb = it.emb || [];
          for (let k = 0; k < it.photos.length; k++) if (!it.emb[k]) it.emb[k] = await Recog.embed(it.photos[k]);
          await saveItem(it); n++; st.textContent = `Обработано ${n} из ${todo.length}`;
        }
        st.textContent = `Готово ✅ (${n} товаров)`;
      } catch (e) { st.textContent = 'Ошибка: ' + e.message; }
    };
    $('#mWipe').onclick = async () => {
      if (!(await confirmBox('Удалить ВСЕ товары, ревизии и файлы с этого телефона? Это нельзя отменить.', 'Удалить всё'))) return;
      await DB.clear('items'); await DB.clear('sessions'); await DB.clear('files'); await DB.kvSet('activeSession', null);
      await reload(); toast('Данные удалены'); route();
    };
  }

  // объединение подсчёта из резервной копии другого телефона в текущую ревизию
  async function mergeCounts() {
    if (!session) return toast('Сначала начните ревизию на этом телефоне');
    const f = await pickFile('.json,application/json'); if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'revizor') throw new Error('Это не файл Ревизора');
      const other = (data.sessions || []).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (!other) throw new Error('В файле нет ревизий');
      const theirItems = new Map((data.items || []).map(i => [i.id, i]));
      let n = 0;
      for (const [oid, c] of Object.entries(other.counts || {})) {
        const ti = theirItems.get(oid);
        let mine = byId(oid) || (ti && ((ti.barcode && items.find(i => i.barcode === ti.barcode)) || items.find(i => Recog.norm(i.name) === Recog.norm(ti.name))));
        if (!mine && ti) { mine = { ...ti, emb: ti.emb || [], photos: ti.photos || [] }; await saveItem(mine); }
        if (!mine) continue;
        const my = session.counts[mine.id] || (session.counts[mine.id] = { qty: 0, locs: {} });
        my.qty = +(my.qty + c.qty).toFixed(3);
        for (const [l, q] of Object.entries(c.locs || {})) my.locs[l] = +((my.locs[l] || 0) + q).toFixed(3);
        session.log.push({ t: Date.now(), id: mine.id, d: c.qty, m: 'объединение', loc: Object.keys(c.locs || {}).join(',') });
        n++;
      }
      session.unknown.push(...(other.unknown || []));
      await saveSession();
      toast(`Добавлено позиций: ${n} из «${other.name}»`, 3500);
    } catch (e) { toast(e.message, 4000); }
  }

  // ---------- установка, сеть, запуск ----------
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
  $('#installBtn').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#installBtn').hidden = true; };
  const net = () => { const n = $('#netState'); n.textContent = navigator.onLine ? 'онлайн' : 'офлайн'; n.className = 'pill ' + (navigator.onLine ? 'ok' : 'warn'); };
  window.addEventListener('online', net); window.addEventListener('offline', net);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopScanner(); else if (location.hash === '#count' && countMode === 'scan' && session) drawMode(); });

  (async () => {
    S = { ...DEFAULTS, ...(await DB.kvGet('settings', {})) };
    applyTheme(); net();
    await reload();
    DB.persist();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
    route();
  })();
})();
