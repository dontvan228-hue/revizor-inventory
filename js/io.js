// Импорт / экспорт: Excel (xlsx/xls), CSV, резервная копия JSON, шаблон.
const IO = (() => {
  const FIELDS = {
    name: ['наименование', 'название', 'товар', 'номенклатура', 'наименование товара', 'name', 'product', 'item', 'title'],
    sku: ['артикул', 'sku', 'article', 'art', 'part number', 'артикул товара'],
    code: ['код', 'код товара', 'код номенклатуры', 'короткий код', 'code'],
    barcode: ['штрихкод', 'штрих код', 'штрих-код', 'шк', 'ean', 'ean13', 'barcode', 'upc', 'gtin', 'штрихкоды'],
    qty: ['количество', 'кол во', 'кол-во', 'остаток', 'учет', 'учёт', 'по учету', 'учетное количество', 'количество учет', 'остаток на складе', 'остаток на дату', 'остаток конечный', 'qty', 'quantity', 'stock', 'остатки'],
    price: ['цена', 'стоимость', 'цена за ед', 'цена продажи', 'цена реализации', 'price', 'cost', 'розничная цена', 'закупочная цена', 'себестоимость'],
    unit: ['ед', 'ед изм', 'ед. изм.', 'единица', 'единица измерения', 'unit', 'uom'],
    category: ['категория', 'группа', 'группа товаров', 'раздел', 'category', 'group'],
    location: ['место', 'склад', 'ячейка', 'полка', 'зона', 'местоположение', 'location', 'bin', 'shelf'],
    minQty: ['мин', 'минимум', 'мин остаток', 'min', 'min qty', 'reorder'],
    notes: ['примечание', 'комментарий', 'описание', 'notes', 'comment', 'description']
  };
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[.,_\-()/:№#]+/g, ' ').replace(/\s+/g, ' ').trim();
  function mapHeaders(headers) {
    const map = {};
    headers.forEach((h, i) => {
      const n = norm(h);
      for (const [f, syn] of Object.entries(FIELDS)) {
        if (map[f] !== undefined) continue;
        if (syn.some(s => norm(s) === n) || syn.some(s => n.startsWith(norm(s) + ' '))) { map[f] = i; break; }
      }
    });
    return map;
  }
  // Короткое название без единиц измерения и скобок — это раздел каталога, а не товар
  const isSection = n => n.length <= 32 && n.split(' ').length <= 5 && !/[()]|\d+[.,]?\d*\s*(мл|мг|ml|mg|шт|mah|ом|ohm|л|г|мм|затяж)/i.test(n);
  const num = v => {
    if (v === '' || v == null) return null;
    if (typeof v === 'number') return v;
    let s = String(v).replace(/[\s ₽руб.]*$/i, '').replace(/[\s ]/g, '');
    if (/,\d{3}(\D|$)/.test(s) && s.includes('.')) s = s.replace(/,/g, '');      // 1,950.50
    else if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');            // 1,950
    else s = s.replace(',', '.');                                               // 89,90
    const n = parseFloat(s); return isNaN(n) ? null : n;
  };

  async function readSheet(file) {
    if (!window.XLSX) throw new Error('Библиотека Excel ещё грузится, попробуйте через секунду');
    const buf = await file.arrayBuffer();
    let wb;
    if (/\.(csv|txt|tsv)$/i.test(file.name)) {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch { text = new TextDecoder('windows-1251').decode(buf); }
      wb = XLSX.read(text.replace(/^﻿/, ''), { type: 'string', raw: true });
    } else {
      wb = XLSX.read(buf, { type: 'array' });
    }
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    // ищем строку заголовков (первая, где распознано хотя бы "наименование")
    let hi = 0, map = {};
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const m = mapHeaders(rows[i]);
      if (m.name !== undefined) { hi = i; map = m; break; }
    }
    if (map.name === undefined) throw new Error('Не нашёл колонку «Наименование». Скачайте шаблон в разделе «Ещё».');
    const out = [];
    let section = '';
    for (const r of rows.slice(hi + 1)) {
      const rawName = String(r[map.name] || '');
      const name = rawName.replace(/\s+/g, ' ').trim();
      if (!name) continue;
      const g = f => map[f] === undefined ? '' : String(r[map[f]] ?? '').trim();
      // Строка-раздел (как в выгрузке каталога Saby): только короткое название, без цены/остатка/кодов
      const others = Object.keys(map).filter(f => f !== 'name').some(f => g(f) !== '');
      if (!others && isSection(name)) { section = name; continue; }
      out.push({
        srcName: rawName.trim(), category: g('category') || section,
        name, sku: g('sku'), code: g('code'), barcode: g('barcode').split(/[,;\s]+/).filter(Boolean)[0] || '', barcodes: g('barcode').split(/[,;\s]+/).filter(Boolean).slice(1), qty: num(g('qty')), price: num(g('price')),
        unit: g('unit') || 'шт', location: g('location'), minQty: num(g('minQty')), notes: g('notes')
      });
    }
    return { rows: out, mapped: Object.keys(map) };
  }

  async function importItems(file) {
    const { rows, mapped } = await readSheet(file);
    const items = await DB.all('items');
    const byBar = new Map(), bySku = new Map(), byName = new Map(), byCode = new Map();
    for (const it of items) {
      if (it.code) byCode.set(String(it.code), it);
      if (it.barcode) byBar.set(String(it.barcode), it);
      if (it.sku) bySku.set(norm(it.sku), it);
      byName.set(norm(it.name), it);
    }
    let added = 0, updated = 0, dups = 0; const toSave = []; const touched = new Set();
    for (const r of rows) {
      let it = (r.code && byCode.get(r.code)) || (r.barcode && byBar.get(r.barcode)) || (r.sku && bySku.get(norm(r.sku))) || byName.get(norm(r.name));
      if (it && touched.has(it.id)) {
        // Тот же товар второй карточкой в этом же файле (дубль в Saby): остатки складываем
        it.qty = +((+it.qty || 0) + (r.qty || 0)).toFixed(3);
        it.dupCards = (it.dupCards || 1) + 1;
        it.dupInfo = [...(it.dupInfo || []), `${r.category || '—'}: ${r.qty ?? 0} шт по ${r.price ?? 0}`];
        if (r.price && r.price !== it.price) it.priceConflict = true;
        dups++; continue;
      }
      if (it) {
        it.dupCards = 1; it.dupInfo = [`${r.category || '—'}: ${r.qty ?? 0} шт по ${r.price ?? 0}`]; it.priceConflict = false;
        for (const k of ['name', 'srcName', 'sku', 'code', 'barcode', 'unit', 'category', 'location', 'notes']) if (r[k]) it[k] = r[k];
        if (r.barcode) it.srcBarcode = true;
        for (const k of ['qty', 'price', 'minQty']) if (r[k] !== null) it[k] = r[k];
        if (r.qty === null && mapped.includes('qty')) it.qty = 0; // пустой остаток в выгрузке = 0
        if (r.barcodes.length) it.barcodes = [...new Set([...(it.barcodes || []), ...r.barcodes])];
        it.updatedAt = Date.now(); updated++;
      } else {
        it = { id: DB.uid(), photos: [], emb: [], createdAt: Date.now(), updatedAt: Date.now(), ...r, srcBarcode: !!r.barcode, qty: r.qty ?? 0, price: r.price ?? 0, minQty: r.minQty ?? 0, dupCards: 1, dupInfo: [`${r.category || '—'}: ${r.qty ?? 0} шт по ${r.price ?? 0}`] };
        if (it.code) byCode.set(it.code, it);
        if (it.barcode) byBar.set(it.barcode, it);
        if (it.sku) bySku.set(norm(it.sku), it);
        byName.set(norm(it.name), it);
        added++;
      }
      touched.add(it.id);
      toSave.push(it);
    }
    await DB.putMany('items', toSave);
    return { added, updated, dups, mapped };
  }

  function bookBlob(wb) {
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function sheet(rows, widths) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    if (widths) ws['!cols'] = widths.map(w => ({ wch: w }));
    return ws;
  }
  async function deliver(blob, filename, share = false) {
    if (share && navigator.canShare) {
      const f = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [f] })) {
        try { await navigator.share({ files: [f], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');

  async function exportCatalog(format = 'xlsx', share = false) {
    const items = await DB.all('items');
    const head = ['Наименование', 'Код', 'Артикул', 'Штрихкод', 'Категория', 'Место', 'Ед.', 'Цена', 'Количество', 'Мин. остаток', 'Примечание'];
    const rows = [head, ...items.map(i => [i.name, i.code, i.sku, i.barcode, i.category, i.location, i.unit, i.price, i.qty, i.minQty, i.notes])];
    if (format === 'csv') {
      const csv = rows.map(r => r.map(v => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
      return deliver(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `katalog_${stamp()}.csv`, share);
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet(rows, [40, 10, 14, 16, 16, 12, 6, 10, 10, 10, 30]), 'Каталог');
    return deliver(bookBlob(wb), `katalog_${stamp()}.xlsx`, share);
  }

  function sessionRows(session, items) {
    const counted = session.counts || {};
    const rows = [];
    let sumBook = 0, sumFact = 0, sumDiff = 0, matched = 0, short = 0, extra = 0;
    for (const it of items) {
      const c = counted[it.id];
      if (session.scope === 'counted' && !c) continue;
      const book = +it.qty || 0, fact = c ? c.qty : 0, diff = fact - book, price = +it.price || 0;
      sumBook += book * price; sumFact += fact * price; sumDiff += diff * price;
      if (diff === 0) matched++; else if (diff < 0) short++; else extra++;
      rows.push({ it, book, fact, diff, price, counted: !!c, locs: c && c.locs ? Object.entries(c.locs).map(([l, q]) => `${l}: ${q}`).join(', ') : '' });
    }
    return { rows, totals: { sumBook, sumFact, sumDiff, matched, short, extra } };
  }

  // ---------- пересорт и минусы ----------
  // Насколько два товара похожи (кандидаты на пересорт: продали/списали/приняли один вместо другого).
  // Вкусы и слова, которые в карточках пишут то по-английски, то по-русски
  const DICT = {
    watermelon: 'арбуз', ice: 'лед', icy: 'лед', mint: 'мята', peppermint: 'мята', pepper: 'перечн', grape: 'виноград', grapes: 'виноград',
    strawberry: 'клубник', blueberry: 'черник', bluberry: 'черник', raspberry: 'малин', rasberry: 'малин', cherry: 'вишн', apple: 'яблок',
    mango: 'манго', peach: 'персик', lemon: 'лимон', lime: 'лайм', banana: 'банан', kiwi: 'киви', pineapple: 'ананас', coconut: 'кокос',
    coffee: 'кофе', vanilla: 'ванил', energy: 'энерге', cola: 'кола', grapefruit: 'грейпф', berries: 'ягод', berry: 'ягод', pear: 'груш',
    orange: 'апельс', melon: 'дын', cranberry: 'клюкв', blackberry: 'ежевик', currant: 'смород', tobacco: 'табак', passion: 'маракуй',
    guava: 'гуав', lychee: 'личи', cream: 'крем', candy: 'конфет', gum: 'жвачк', tea: 'чай', cool: 'холод', sour: 'кисл', pina: 'пина', colada: 'колад'
  };
  const STOP = new Set(['оэсдн', 'эсдн', 'электронная', 'сигарета', 'жидкость', 'для', 'с', 'и', 'со', 'в', 'затяжек', 'вкус', 'ароматом', 'шт', 'штук']);
  const stem = w => { w = DICT[w] || w; if (/^(лед|ледян|льд|холод)/.test(w) && !/^леден/.test(w)) return 'лед'; if (w === 'дын') w = 'дыня'; if (/^[а-я]+$/.test(w) && w.length >= 4) return w.slice(0, 4); return w; };
  const toks = s => new Set(Recog.norm(s).split(' ').filter(w => w.length > 1 && !STOP.has(w)).map(stem));
  const skuStem = s => String(s || '').toLowerCase().replace(/[^a-zа-я0-9]/gi, '').replace(/\d+$/, '').slice(0, 6);
  // Вес слова: редкие слова (вкус, модель) важнее частых (salt, 30ml, затяжек)
  let idf = null;
  function buildIdf(items) {
    const df = new Map();
    for (const it of items) for (const t of toks(it.name)) df.set(t, (df.get(t) || 0) + 1);
    idf = { n: items.length, df };
  }
  const weight = t => idf ? Math.log(1 + idf.n / (idf.df.get(t) || 1)) : 1;
  function similarity(a, b) {
    if (a.id === b.id) return 0;
    if ((a.unit || 'шт') !== (b.unit || 'шт')) return 0;
    const pa = +a.price || 0, pb = +b.price || 0;
    if (pa && pb && Math.max(pa, pb) / Math.min(pa, pb) > 3) return 0;
    const ta = toks(a.name), tb = toks(b.name);
    let wi = 0, wu = 0;
    for (const t of new Set([...ta, ...tb])) { const w = weight(t); wu += w; if (ta.has(t) && tb.has(t)) wi += w; }
    // основа — взвешенное совпадение слов (бренд, линейка, вкус); бонусы небольшие
    let s = wu ? (wi / wu) * 0.85 : 0;
    if (a.category && a.category === b.category) s += 0.1;
    if (pa && pb && Math.max(pa, pb) / Math.min(pa, pb) <= 1.3) s += 0.05;
    const sa = skuStem(a.sku), sb = skuStem(b.sku);
    if (sa.length >= 2 && sa === sb) s += 0.05;
    return Math.min(1, s);
  }
  // Подбирает пары «недостача ↔ излишек» похожих товаров и зачитывает количество.
  function regrade(rows, minSim = 0.4) {
    buildIdf(rows.map(r => r.it));
    const shorts = rows.filter(r => r.diff < 0).map(r => ({ r, left: -r.diff }));
    const extras = rows.filter(r => r.diff > 0).map(r => ({ r, left: r.diff }));
    const cand = [];
    for (const s of shorts) for (const e of extras) { const sim = similarity(s.r.it, e.r.it); if (sim >= minSim) cand.push({ s, e, sim }); }
    cand.sort((x, y) => y.sim - x.sim);
    const pairs = [];
    for (const c of cand) {
      const q = Math.min(c.s.left, c.e.left); if (q <= 0) continue;
      c.s.left -= q; c.e.left -= q;
      pairs.push({ short: c.s.r.it, extra: c.e.r.it, qty: +q.toFixed(3), sim: c.sim, sumShort: q * (+c.s.r.it.price || 0), sumExtra: q * (+c.e.r.it.price || 0) });
    }
    const covered = pairs.reduce((s, p) => s + Math.min(p.sumShort, p.sumExtra), 0);
    return { pairs, covered };
  }
  // Для товаров с минусом по учёту — похожие товары с плюсом (с чем вероятно пересорт).
  function negativeSuspects(items) {
    if (!idf || idf.n !== items.length) buildIdf(items);
    return items.filter(i => (+i.qty || 0) < 0).map(neg => ({
      neg, partners: items.filter(o => (+o.qty || 0) > 0).map(o => ({ o, sim: similarity(neg, o) })).filter(x => x.sim >= 0.35).sort((a, b) => b.sim - a.sim).slice(0, 3).map(x => x.o)
    }));
  }

  async function exportReport(session, share = false) {
    const items = await DB.all('items');
    const { rows, totals } = sessionRows(session, items);
    const rg = regrade(rows);
    const wb = XLSX.utils.book_new();
    const head = ['Наименование', 'Артикул', 'Штрихкод', 'Ед.', 'Место', 'Цена', 'По учёту', 'Факт', 'Разница', 'Сумма разницы', 'Посчитан', 'По местам'];
    const data = [
      [`Инвентаризация: ${session.name}`], [`Начата: ${new Date(session.startedAt).toLocaleString('ru-RU')}` + (session.finishedAt ? `, завершена: ${new Date(session.finishedAt).toLocaleString('ru-RU')}` : '')],
      [`Совпало: ${totals.matched}, недостача: ${totals.short}, излишек: ${totals.extra}, сумма расхождения: ${totals.sumDiff.toFixed(2)}`], [],
      head,
      ...rows.map(r => [r.it.name, r.it.sku, r.it.barcode, r.it.unit, r.it.location, r.price, r.book, r.fact, r.diff, +(r.diff * r.price).toFixed(2), r.counted ? 'да' : 'нет', r.locs])
    ];
    XLSX.utils.book_append_sheet(wb, sheet(data, [40, 14, 16, 6, 12, 10, 10, 10, 10, 14, 9, 30]), 'Сличительная');
    const diffs = rows.filter(r => r.diff !== 0);
    XLSX.utils.book_append_sheet(wb, sheet([head, ...diffs.map(r => [r.it.name, r.it.sku, r.it.barcode, r.it.unit, r.it.location, r.price, r.book, r.fact, r.diff, +(r.diff * r.price).toFixed(2), r.counted ? 'да' : 'нет', r.locs])], [40, 14, 16, 6, 12, 10, 10, 10, 10, 14, 9, 30]), 'Расхождения');
    XLSX.utils.book_append_sheet(wb, sheet([
      ['Возможный пересорт: недостача одного товара перекрывается излишком похожего'], [],
      ['Недостача (товар)', 'Артикул', 'Излишек (товар)', 'Артикул', 'Кол-во к зачёту', 'Цена недост.', 'Цена изл.', 'Разница в сумме', 'Схожесть, %'],
      ...rg.pairs.map(p => [p.short.name, p.short.sku, p.extra.name, p.extra.sku, p.qty, +p.short.price || 0, +p.extra.price || 0, +(p.sumExtra - p.sumShort).toFixed(2), Math.round(p.sim * 100)]),
      [], [`Пересорт закрывает недостачи на сумму: ${rg.covered.toFixed(2)}`]
    ], [36, 12, 36, 12, 12, 12, 12, 14, 11]), 'Пересорт');
    const dupRows = rows.filter(r => (r.it.dupCards || 1) > 1);
    if (dupRows.length) XLSX.utils.book_append_sheet(wb, sheet([
      ['Наименование', 'Карточек в Saby', 'Разбивка по карточкам', 'Разные цены', 'Учёт (сумма)', 'Факт'],
      ...dupRows.map(r => [r.it.name, r.it.dupCards, (r.it.dupInfo || []).join('; '), r.it.priceConflict ? 'да' : '', r.book, r.fact])
    ], [50, 10, 60, 10, 12, 10]), 'Дубли карточек');
    const negs = rows.filter(r => r.book < 0);
    if (negs.length) XLSX.utils.book_append_sheet(wb, sheet([
      ['Наименование', 'Артикул', 'По учёту', 'Факт', 'Разница', 'Возможная причина'],
      ...negs.map(r => [r.it.name, r.it.sku, r.book, r.fact, r.diff, 'Минус в учёте: продали/списали этот товар вместо другого (пересорт) или не проведён приход'])
    ], [40, 14, 10, 10, 10, 70]), 'Минусы в учёте');
    if (session.unknown && session.unknown.length)
      XLSX.utils.book_append_sheet(wb, sheet([['Штрихкод / описание', 'Количество', 'Место'], ...session.unknown.map(u => [u.code, u.qty, u.loc || ''])], [30, 12, 14]), 'Не найдены в каталоге');
    const byId = new Map(items.map(i => [i.id, i]));
    XLSX.utils.book_append_sheet(wb, sheet([['Время', 'Товар', 'Изменение', 'Способ', 'Место'], ...(session.log || []).map(l => [new Date(l.t).toLocaleTimeString('ru-RU'), (byId.get(l.id) || {}).name || l.id, l.d, l.m, l.loc || ''])], [10, 40, 10, 12, 14]), 'Журнал');
    return deliver(bookBlob(wb), `reviziya_${stamp()}.xlsx`, share);
  }

  // Файл для загрузки в Saby: «Склад/Документы» → «+» → «Инвентаризации/Инвентаризация» → скрепка → «Разобрать».
  // Saby сопоставляет товары по наименованию, штрихкоду и артикулу; заголовок в 1-й строке, данные со 2-й.
  async function exportSaby(session, share = false) {
    const items = await DB.all('items');
    const { rows } = sessionRows(session, items);
    const data = [['Наименование', 'Код', 'Артикул', 'Штрихкод', 'Ед. изм.', 'Количество', 'Цена']];
    // Наименование — ровно как в Saby (по нему Saby находит карточку). Штрихкоды, привязанные
    // в Ревизоре, не отправляем: иначе Saby может завести лишнюю карточку.
    for (const r of rows) data.push([r.it.srcName || r.it.name, r.it.code || '', r.it.sku || '', r.it.srcBarcode ? r.it.barcode : '', r.it.unit || 'шт', r.fact, +r.it.price || 0]);
    const wb = XLSX.utils.book_new();
    const ws = sheet(data, [44, 12, 16, 16, 8, 12, 10]);
    // штрихкоды и коды как текст, чтобы Excel не превратил их в 4,6E+12
    for (let i = 1; i < data.length; i++) for (const col of ['B', 'C', 'D']) { const c = ws[col + (i + 1)]; if (c) { c.t = 's'; c.v = String(c.v); } }
    XLSX.utils.book_append_sheet(wb, ws, 'Инвентаризация');
    return deliver(bookBlob(wb), `saby_inventarizaciya_${stamp()}.xlsx`, share);
  }

  async function template() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet([
      ['Наименование', 'Артикул', 'Штрихкод', 'Категория', 'Место', 'Ед.', 'Цена', 'Количество', 'Мин. остаток', 'Примечание'],
      ['Молоко 3,2% 1 л', 'MLK-001', '4600000000017', 'Молочка', 'Холодильник 1', 'шт', 89.9, 24, 6, ''],
      ['Кабель ВВГ 3х2.5', 'CAB-325', '', 'Электрика', 'Стеллаж B2', 'м', 75, 150, 50, 'бухта 100 м']
    ], [40, 14, 16, 16, 14, 6, 10, 10, 10, 30]), 'Каталог');
    return deliver(bookBlob(wb), 'shablon_kataloga.xlsx');
  }

  const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
  async function backup(share = false) {
    const files = await DB.all('files');
    const data = {
      app: 'revizor', version: 1, created: new Date().toISOString(),
      items: await DB.all('items'), sessions: await DB.all('sessions'),
      files: await Promise.all(files.map(async f => ({ ...f, blob: undefined, data: await blobToDataURL(f.blob) })))
    };
    return deliver(new Blob([JSON.stringify(data)], { type: 'application/json' }), `revizor_backup_${stamp()}.json`, share);
  }
  async function restore(file, replace) {
    const data = JSON.parse(await file.text());
    if (data.app !== 'revizor') throw new Error('Это не резервная копия Ревизора');
    if (replace) { await DB.clear('items'); await DB.clear('sessions'); await DB.clear('files'); }
    await DB.putMany('items', data.items || []);
    await DB.putMany('sessions', data.sessions || []);
    const files = [];
    for (const f of data.files || []) { if (!/^data:/.test(f.data || '')) continue; const blob = await (await fetch(f.data)).blob(); const { data: _d, ...rest } = f; files.push({ ...rest, blob }); }
    await DB.putMany('files', files);
    return { items: (data.items || []).length, sessions: (data.sessions || []).length, files: files.length };
  }

  return { importItems, exportCatalog, exportReport, exportSaby, sessionRows, similarity, regrade, negativeSuspects, template, backup, restore, deliver };
})();
