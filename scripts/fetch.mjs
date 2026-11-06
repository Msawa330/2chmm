#!/usr/bin/env node
// 2chmm要約リーダー (standalone) — data generator
// 2chmm.com の一覧 + 各ブログのフィード + おばにゅーWP API から記事を集め、
// data/index.json と data/articles/<id>.json を生成する。依存ライブラリなし (Node 20+)。
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const ARTICLES_DIR = join(DATA_DIR, 'articles');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BODY_FETCH_LIMIT = 150;      // 1回の実行で新規に本文を取得する上限
const ARCHIVE_PER_BLOG = 30;       // ブログ別アーカイブの保持件数
const COMMENT_LIMIT = 300;
const OBANYU_DAYS = 14;
const OBANYU_URL = 'https://overwatch2-news.apexlegends-leaksnews.com/';

const stats = { blogs: 0, articles: 0, bodies: 0, bodiesNew: 0, comments: 0, failed: [] };
const log = (...a) => console.log('[fetch]', ...a);

/* ---------------- fetch + decode ---------------- */
async function fetchBuffer(url, timeoutMs = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '', finalUrl: res.url };
  } finally { clearTimeout(t); }
}
function decodeBuffer(buf, contentType = '') {
  let declared = '';
  const m = /charset=([\w-]+)/i.exec(contentType);
  if (m) declared = m[1].toLowerCase();
  if (!declared) {
    const head = buf.subarray(0, 4096).toString('latin1');
    const mm = /charset=["']?([\w-]+)/i.exec(head);
    if (mm) declared = mm[1].toLowerCase();
  }
  const norm = (e) => e === 'shift-jis' || e === 'sjis' || e === 'x-sjis' ? 'shift_jis' : e === 'eucjp' ? 'euc-jp' : e;
  const candidates = [...new Set([declared && norm(declared), 'utf-8', 'euc-jp', 'shift_jis'].filter(Boolean))];
  let best = null, bestBad = Infinity;
  for (const enc of candidates) {
    try {
      const s = new TextDecoder(enc).decode(buf);
      const bad = (s.match(/\uFFFD/g) || []).length;
      if (bad < bestBad) { best = s; bestBad = bad; }
      if (bad === 0) break;
    } catch { /* unsupported label */ }
  }
  return best ?? buf.toString('utf8');
}
async function fetchText(url, timeoutMs) {
  const { buf, contentType, finalUrl } = await fetchBuffer(url, timeoutMs);
  return { text: decodeBuffer(buf, contentType), finalUrl };
}
async function fetchJSON(url, timeoutMs) {
  const { buf } = await fetchBuffer(url, timeoutMs);
  return JSON.parse(buf.toString('utf8'));
}

/* ---------------- tiny HTML parser ---------------- */
const VOID = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[g] ?? m;
  });
}
// Returns a tree: {tag, attrs:{}, children:[node|string]}
function parseHTML(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0; const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { top().children.push(decodeEntities(html.slice(i))); break; }
    if (lt > i) top().children.push(decodeEntities(html.slice(i, lt)));
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e === -1 ? n : e + 3; continue; }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) { const e = html.indexOf('>', lt); i = e === -1 ? n : e + 1; continue; }
    const gt = findTagEnd(html, lt);
    if (gt === -1) { top().children.push('<'); i = lt + 1; continue; }
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().split(/\s/)[0].toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === name) { stack.length = k; break; }
      continue;
    }
    const selfClose = /\/\s*$/.test(raw);
    const bodyRaw = selfClose ? raw.replace(/\/\s*$/, '') : raw;
    const sp = bodyRaw.search(/[\s]/);
    const name = (sp === -1 ? bodyRaw : bodyRaw.slice(0, sp)).toLowerCase();
    if (!name || !/^[a-z]/.test(name)) { top().children.push('<' + raw + '>'); continue; }
    const attrStr = sp === -1 ? '' : bodyRaw.slice(sp + 1);
    const attrs = {};
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let am; while ((am = attrRe.exec(attrStr))) attrs[am[1].toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? '');
    const node = { tag: name, attrs, children: [] };
    top().children.push(node);
    if (name === 'script' || name === 'style') {
      const close = html.toLowerCase().indexOf('</' + name, i);
      const content = close === -1 ? html.slice(i) : html.slice(i, close);
      if (content) node.children.push(content);
      if (close === -1) { i = n; } else { const cg = html.indexOf('>', close); i = cg === -1 ? n : cg + 1; }
      continue;
    }
    if (!selfClose && !VOID.has(name)) stack.push(node);
  }
  return root;
}
function findTagEnd(html, lt) {
  let q = null;
  for (let i = lt + 1; i < html.length; i++) {
    const c = html[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return -1;
}
function* walkNodes(node) {
  yield node;
  for (const c of node.children) if (typeof c !== 'string') yield* walkNodes(c);
}
function findAll(node, pred) { const out = []; for (const nd of walkNodes(node)) if (pred(nd)) out.push(nd); return out; }
function classTokens(node) { return (node.attrs.class || '').split(/\s+/).filter(Boolean); }
function hasClass(node, name) { return classTokens(node).includes(name); }
function textOf(node) {
  let s = '';
  for (const c of node.children) {
    if (typeof c === 'string') s += c;
    else if (c.tag === 'br') s += '\n';
    else s += textOf(c);
  }
  return s;
}
function absUrl(u, base) { try { return new URL(u, base).href; } catch { return null; } }

/* ---------------- header (post meta) stripping ---------------- */
// 完全なヘッダー行: 「番号: 名前 日付(曜) 時刻.ミリ秒 ID:xxx」「番号： ：日付…」(名前なし)
// 「番号:名前：日付」「番号: 名前 日付」(区切りコロンなし)、2桁年、「2026年11月05日 10:29」形式の全変種に対応
const DATE_PART = String.raw`(?:(?:20)?\d{2}/\d{1,2}/\d{1,2}\s*\([日月火水木金土]\)\s*\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?|\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}(?::\d{2})?)`;
const HEADER_LINE_RE = new RegExp(String.raw`^\s*\d{1,4}\s*[:：]\s*(?:[^:：\n]{0,40}?\s*[:：]?\s*)?` + DATE_PART + String.raw`(?:\s*ID\s*[:：]\s*\S+)?\s*$`);
const HEADER_PREFIX_RE = new RegExp(String.raw`^\s*\d{1,4}\s*[:：]\s*(?:[^:：\n]{0,40}?\s*[:：]?\s*)?` + DATE_PART + String.raw`(?:\s*ID\s*[:：]\s*\S+)?\s+`);
// 「1: 名前」だけの短いヘッダー行 (WP系まとめ等)
const SHORT_HEADER_RE = /^\s*\d{1,4}\s*[:：]\s*\S[^:：\n]{0,30}$/;
function isHeaderLine(text, hasMoreLines) {
  const t = text.trim();
  if (!t) return false;
  if (HEADER_LINE_RE.test(t)) return true;
  if (hasMoreLines && SHORT_HEADER_RE.test(t) && !/[。！？!?、,」』）)]/.test(t.slice(t.indexOf(':') + 1)) && t.length <= 36) return true;
  return false;
}

/* ---------------- style helpers ---------------- */
const FONT_SIZE_MAP = { 1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
function parseStyle(style = '') {
  const out = {};
  for (const part of style.split(';')) {
    const idx = part.indexOf(':');
    if (idx > 0) out[part.slice(0, idx).trim().toLowerCase()] = part.slice(idx + 1).trim();
  }
  return out;
}
const AD_CLASS_RE = /(^|[-_\s])(ad|ads|advert|sponsor|pr|affiliate|rakuten|amazon)([-_\s]|$)/i;
const AD_URL_RE = /(amazon\.(co\.jp|com)\/(gp|dp|.*tag=)|rakuten|a8\.net|valuecommerce|accesstrade|ad\.|ads\.|doubleclick|googlesyndication|px\.a8|b\.hatena|share_|twitter-share|facebook\.com\/sharer|line\.me\/R\/msg|intent\/tweet)/i;
const IMG_SKIP_RE = /(banner|logo|icon|favicon|button|btn|share|pixel|spacer|blank|hatena|bookmark|feedly|pocket|line_|twitter|facebook|instagram|ranking|badge)/i;

/* body walker: node -> flat items (segments + breaks), inheriting inline style */
function walkBody(node, ctx, items, base) {
  if (typeof node === 'string') {
    const text = node.replace(/[ \t\r\f\v]+/g, ' ');
    // ベタ書き画像URLを画像化
    const urlRe = /(https?:\/\/[^\s"'<>]+)/g;
    let last = 0, m;
    while ((m = urlRe.exec(text))) {
      const before = text.slice(last, m.index);
      if (before) items.push({ ...ctx, text: before });
      const u = m[1].replace(/[)、。」』]+$/, '');
      const rest = m[1].slice(u.length);
      if (/\.(jpe?g|png|gif|webp)(\?.*)?$/i.test(u)) items.push({ img: u });
      else if (/^https?:\/\/imgur\.com\/([A-Za-z0-9]{5,8})\/?$/.test(u)) items.push({ img: `https://i.imgur.com/${RegExp.$1}.jpg` });
      else items.push({ ...ctx, text: u });
      if (rest) items.push({ ...ctx, text: rest });
      last = m.index + m[1].length;
    }
    const tail = text.slice(last);
    if (tail) items.push({ ...ctx, text: tail });
    return;
  }
  const tag = node.tag;
  if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'form' || tag === 'select' || tag === 'textarea' || tag === 'button') return;
  const cls = (node.attrs.class || '') + ' ' + (node.attrs.id || '');
  if (AD_CLASS_RE.test(cls)) return;
  const nctx = { ...ctx };
  const st = parseStyle(node.attrs.style || '');
  if (st.color) nctx.color = st.color;
  if (st['font-size']) { const px = parseFloat(st['font-size']); if (px >= 8 && px <= 60) nctx.size = Math.round(px); }
  if (st['font-weight'] && (st['font-weight'] === 'bold' || parseInt(st['font-weight']) >= 600)) nctx.bold = true;
  if (tag === 'b' || tag === 'strong') nctx.bold = true;
  if (tag === 'font') {
    if (node.attrs.color) nctx.color = node.attrs.color;
    if (node.attrs.size) {
      const s = node.attrs.size.trim();
      if (/^[1-7]$/.test(s)) nctx.size = FONT_SIZE_MAP[s];
      else if (/^[+-][1-6]$/.test(s)) { const base16 = [10, 13, 16, 18, 24, 32, 48]; const idx = Math.min(6, Math.max(0, 2 + parseInt(s))); nctx.size = base16[idx]; }
    }
  }
  if (tag === 'a') {
    const href = node.attrs.href ? absUrl(node.attrs.href, base) : null;
    if (href && /^https?:/.test(href) && !AD_URL_RE.test(href)) nctx.href = href; else nctx.href = undefined;
  }
  if (tag === 'img') {
    const src = node.attrs.src || node.attrs['data-src'] || node.attrs['data-original'] || '';
    const u = src ? absUrl(src, base) : null;
    const w = parseInt(node.attrs.width || ''), hgt = parseInt(node.attrs.height || '');
    if (u && /^https?:/.test(u) && !IMG_SKIP_RE.test(u) && !AD_URL_RE.test(u) && !(w > 0 && w <= 2) && !(hgt > 0 && hgt <= 2)) items.push({ img: u });
    return;
  }
  if (tag === 'video') {
    const src = node.attrs.src || node.children.find(c => typeof c !== 'string' && c.tag === 'source')?.attrs.src;
    const u = src ? absUrl(src, base) : null;
    if (u) { items.push({ br: 1 }); items.push({ text: u, href: u }); items.push({ br: 1 }); }
    return;
  }
  if (tag === 'iframe') {
    const src = node.attrs.src ? absUrl(node.attrs.src, base) : null;
    if (src && /youtube/.test(src)) { items.push({ br: 1 }); items.push({ text: src, href: src }); items.push({ br: 1 }); }
    return;
  }
  if (tag === 'br') { items.push({ br: 1 }); return; }
  const BLOCK = new Set(['div', 'p', 'li', 'tr', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'table', 'ul', 'ol', 'pre', 'figure', 'figcaption', 'dd', 'dt']);
  const isBlock = BLOCK.has(tag);
  if (isBlock) items.push({ br: 1 });
  for (const c of node.children) walkBody(c, nctx, items, base);
  if (isBlock) items.push({ br: 1 });
}

/* items -> lines -> posts */
function itemsToPosts(items) {
  // lines: array of segment arrays
  const lines = [[]];
  for (const it of items) {
    if (it.br) { if (lines[lines.length - 1].length) lines.push([]); continue; }
    lines[lines.length - 1].push(it);
  }
  const posts = [];
  let cur = [];
  const flush = () => {
    const cleaned = cur.map(segs => segs.filter(s => s.img || (s.text && s.text.trim()))).filter(segs => segs.length);
    const norm = cleaned.map(segs => segs.map(s => s.img ? s : { ...s, text: s.text.replace(/\s+/g, ' ').trim() === '' ? ' ' : s.text }));
    const has = norm.some(segs => segs.some(s => s.img || (s.text || '').trim()));
    if (has) posts.push(norm.flatMap(segs => [...segs, { br: 1 }]).slice(0, -1));
    cur = [];
  };
  lines.forEach((segs, li) => {
    const text = segs.map(s => s.img ? '' : (s.text || '')).join('');
    const hasImg = segs.some(s => s.img);
    if (!hasImg && isHeaderLine(text, li < lines.length - 1)) { flush(); return; }
    if (!hasImg && HEADER_PREFIX_RE.test(text)) {
      flush();
      const stripped = text.replace(HEADER_PREFIX_RE, '');
      const first = segs.find(s => !s.img && s.text);
      if (first) { const pos = first.text.indexOf(stripped.slice(0, 10)); first.text = pos >= 0 ? first.text.slice(pos) : stripped; }
    }
    cur.push(segs);
  });
  flush();
  return posts.filter(p => p.some(s => s.img || (s.text || '').trim().length >= 1)).slice(0, 400);
}

/* ---------------- article page extraction ---------------- */
function extractPublishedAt(root, htmlText) {
  const abbr = findAll(root, nd => nd.tag === 'abbr' && /^\d{4}-\d{2}-\d{2}T/.test(nd.attrs.title || ''))[0];
  if (abbr) { const t = Date.parse(abbr.attrs.title); if (t) return t; }
  const time = findAll(root, nd => nd.tag === 'time' && nd.attrs.datetime)[0];
  if (time) { const t = Date.parse(time.attrs.datetime); if (t) return t; }
  const meta = /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i.exec(htmlText) || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i.exec(htmlText);
  if (meta) { const t = Date.parse(meta[1]); if (t) return t; }
  const ld = /"datePublished"\s*:\s*"([^"]+)"/.exec(htmlText);
  if (ld) { const t = Date.parse(ld[1]); if (t) return t; }
  const dc = /dc:date="([^"]+)"/.exec(htmlText);
  if (dc) { const t = Date.parse(dc[1]); if (t) return t; }
  return null;
}
function extractFeedUrl(root, base) {
  const link = findAll(root, nd => nd.tag === 'link' && /alternate/.test(nd.attrs.rel || '') && /(rss|atom)/.test(nd.attrs.type || ''))[0];
  return link ? absUrl(link.attrs.href, base) : null;
}
function extractComments(root) {
  const out = [];
  const seen = new Set();
  const els = findAll(root, nd => {
    const toks = classTokens(nd);
    return toks.includes('commenttext') || toks.includes('comment-body') || toks.includes('comment_body') || toks.includes('commentText');
  });
  for (const el of els) {
    const t = textOf(el).replace(/\u00A0/g, ' ').split('\n').map(s => s.trim()).filter(Boolean).join('\n').trim();
    if (!t || t.length > 2000) continue;
    if (/^(コメント|名前|メール|投稿する|※)/.test(t) && t.length < 30) continue;
    if (seen.has(t)) continue;
    seen.add(t); out.push(t);
    if (out.length >= COMMENT_LIMIT) break;
  }
  return out;
}
const BODY_SELECTORS = [
  nd => hasClass(nd, 'article-body'), nd => hasClass(nd, 'entry-content'), nd => hasClass(nd, 'articleBody'),
  nd => hasClass(nd, 'post-body'), nd => hasClass(nd, 'article_body'), nd => hasClass(nd, 'mainmore'),
  nd => nd.tag === 'article',
];
function extractBody(root, base) {
  const tb = findAll(root, nd => hasClass(nd, 't_b'));
  if (tb.length >= 1) {
    const posts = [];
    for (const el of tb) { const items = []; for (const c of el.children) walkBody(c, {}, items, base); posts.push(...itemsToPosts(items)); }
    if (posts.length) return posts;
  }
  let container = null;
  for (const sel of BODY_SELECTORS) {
    const cands = findAll(root, sel).filter(nd => !findAll(nd, x => hasClass(x, 'commenttext')).length || hasClass(nd, 'article-body'));
    if (cands.length) { container = cands.sort((a, b) => textOf(b).length - textOf(a).length)[0]; break; }
  }
  if (!container) {
    const divs = findAll(root, nd => nd.tag === 'div');
    container = divs.sort((a, b) => textOf(b).length - textOf(a).length)[0] || root;
  }
  const items = [];
  for (const c of container.children) walkBody(c, {}, items, base);
  return itemsToPosts(items);
}

/* ---------------- feeds ---------------- */
function parseFeed(xmlText) {
  const items = [];
  const isAtom = /<feed[\s>]/.test(xmlText.slice(0, 400));
  const blocks = xmlText.split(/<(?:item|entry)[\s>]/).slice(1);
  for (const b of blocks) {
    const title = (/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(b) || [])[1] || '';
    let link = '';
    const lm = /<link[^>]*href="([^"]+)"/.exec(b) || /<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/.exec(b) || /<guid[^>]*isPermaLink="true"[^>]*>([\s\S]*?)<\/guid>/.exec(b);
    if (lm) link = (lm[1] || '').trim();
    const dm = /<(?:pubDate|published|updated|dc:date)>([\s\S]*?)<\//.exec(b);
    const t = dm ? Date.parse(dm[1].trim()) : NaN;
    const cleanTitle = decodeEntities(title.replace(/<[^>]+>/g, '')).trim();
    if (link && cleanTitle) items.push({ title: cleanTitle, url: link, publishedAt: Number.isFinite(t) ? t : null });
  }
  return items;
}
async function tryFeed(url) {
  try { const { text } = await fetchText(url, 8000); if (/<(rss|feed|rdf)/i.test(text.slice(0, 500))) { const items = parseFeed(text); if (items.length) return items; } } catch { /* ignore */ }
  return null;
}

/* ---------------- ids / categories ---------------- */
const idOf = (url) => createHash('sha256').update(url.replace(/#.*$/, '')).digest('hex').slice(0, 12);
function categoryOf(name) {
  if (/ハムスター|猫|犬|動物|癒し|ほっこり|ペット/.test(name)) return 'animal';
  if (/ゲーム|アニメ|オタ|漫画|マンガ|ポケモン|ガンダム|NIKKE|萌え/.test(name)) return 'game';
  if (/芸能|アイドル|声優|ジャニーズ|女優|俳優/.test(name)) return 'entertainment';
  if (/ニュース|速報|まとめ|VIP|2ch|コピペ|質問|哲学|歴史|IT|PC|理系|マネー|お金|サッカー|野球|フード|料理|食べ|登山|アウトドア|英語|海外|不思議|怖い|修羅場|鬼女|人生|働く/.test(name)) return 'news';
  return 'other';
}
function unwrapUrl(u) {
  try {
    const url = new URL(u);
    if (url.hostname === 'blog.livedoor.com' && url.pathname.includes('matomeportal')) {
      const inner = url.searchParams.get('url');
      if (inner) return inner;
    }
    return url.href;
  } catch { return u; }
}

/* ---------------- main ---------------- */
async function main() {
  await mkdir(ARTICLES_DIR, { recursive: true });
  const blogs = new Map();    // blogKey -> {key,name,url,category,pinned}
  const articles = new Map(); // id -> {id, blogKey, title, url, publishedAt}
  const addBlog = (name, url, pinned = false) => {
    const key = idOf('blog:' + name);
    if (!blogs.has(key)) blogs.set(key, { key, name, url, category: pinned ? 'game' : categoryOf(name), pinned });
    return key;
  };
  const addArticle = (blogKey, title, url, publishedAt) => {
    const u = unwrapUrl(url);
    if (/\.(css|js|ico|png|jpe?g|gif|xml|json)(\?|$)/i.test(u)) return null; // フィード誤検出などのゴミURLを除外
    const id = idOf(u);
    const prev = articles.get(id);
    if (!prev) articles.set(id, { id, blogKey, title: title.trim(), url: u, publishedAt: publishedAt ?? null });
    else { if (!prev.publishedAt && publishedAt) prev.publishedAt = publishedAt; if (!prev.title && title) prev.title = title.trim(); }
    return id;
  };

  /* 1) 2chmm atom (正確な公開時刻) */
  const atomTimes = new Map();
  try {
    const { text } = await fetchText('https://2chmm.com/atom.xml');
    for (const it of parseFeed(text)) atomTimes.set(it.title.replace(/\s+/g, ''), it.publishedAt);
    log('atom entries:', atomTimes.size);
  } catch (e) { log('atom failed', e.message); }

  /* 2) 2chmm TOP (ブログ別セクション) */
  try {
    const { text } = await fetchText('https://2chmm.com/');
    const root = parseHTML(text);
    let curKey = null;
    for (const nd of walkNodes(root)) {
      if (nd.tag === 'h2') {
        const a = nd.children.find(c => typeof c !== 'string' && c.tag === 'a');
        if (a) { const name = textOf(a).trim(); if (name) curKey = addBlog(name, a.attrs.href || ''); }
      } else if (nd.tag === 'li' && hasClass(nd, 'post') && curKey) {
        const a = nd.children.find(c => typeof c !== 'string' && c.tag === 'a');
        if (a && a.attrs.href) {
          const title = textOf(a).trim();
          const t = atomTimes.get(title.replace(/\s+/g, ''));
          addArticle(curKey, title, a.attrs.href, t ?? null);
        }
      }
    }
    log('2chmm blogs:', blogs.size, 'articles:', articles.size);
  } catch (e) { stats.failed.push('2chmm TOP: ' + e.message); log('2chmm TOP failed', e.message); }

  /* 3) おばにゅー (WP API, 直近14日) */
  const obanyuKey = addBlog('おばにゅー', OBANYU_URL, true);
  const wpPosts = new Map(); // articleId -> wp post id
  try {
    const after = new Date(Date.now() - OBANYU_DAYS * 86400000).toISOString();
    for (let page = 1; page <= 4; page++) {
      const posts = await fetchJSON(`${OBANYU_URL}wp-json/wp/v2/posts?per_page=100&page=${page}&after=${encodeURIComponent(after)}&_fields=id,date,link,title,content`);
      if (!Array.isArray(posts) || !posts.length) break;
      for (const p of posts) {
        const title = decodeEntities(String(p.title?.rendered || '').replace(/<[^>]+>/g, '')).trim();
        const id = addArticle(obanyuKey, title, p.link, Date.parse(p.date) || null);
        wpPosts.set(id, { wpId: p.id, contentHtml: p.content?.rendered || '' });
      }
      if (posts.length < 100) break;
    }
    log('obanyu posts:', wpPosts.size);
  } catch (e) { stats.failed.push('おばにゅー: ' + e.message); log('obanyu failed', e.message); }

  /* 4) 前回データのマージ (本文のある記事・過去アーカイブを保持) */
  const existingBodies = new Set();
  try {
    for (const f of await readdir(ARTICLES_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { JSON.parse(await readFile(join(ARTICLES_DIR, f), 'utf8')); existingBodies.add(f.replace('.json', '')); }
      catch { log('discarding corrupt body file:', f); }
    }
    const prev = JSON.parse(await readFile(join(DATA_DIR, 'index.json'), 'utf8'));
    for (const b of prev.blogs || []) if (!blogs.has(b.key)) blogs.set(b.key, b);
    for (const a of prev.articles || []) if (!articles.has(a.id)) articles.set(a.id, a);
    log('merged previous: bodies', existingBodies.size, 'articles total', articles.size);
  } catch { log('no previous data (first run)'); }

  /* 5) 本文取得 (新規分のみ・上限あり) */
  const feedUrlByBlog = new Map();
  const sorted = [...articles.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  const todo = sorted.filter(a => !existingBodies.has(a.id)).slice(0, BODY_FETCH_LIMIT);
  log('body fetch targets:', todo.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const a = todo[cursor++];
      try {
        if (wpPosts.has(a.id)) {
          const { wpId, contentHtml } = wpPosts.get(a.id);
          const frag = parseHTML(contentHtml);
          const items = [];
          for (const c of frag.children) walkBody(c, {}, items, a.url);
          const posts = itemsToPosts(items);
          let comments = [];
          try {
            const cs = await fetchJSON(`${OBANYU_URL}wp-json/wp/v2/comments?post=${wpId}&per_page=100&_fields=content`);
            for (const c of cs || []) {
              const cf = parseHTML(c.content?.rendered || '');
              const t = textOf(cf).replace(/\u00A0/g, ' ').split('\n').map(s => s.trim()).filter(Boolean).join(' ').trim();
              const clean = t.replace(/[\s*]*$/, '');
              if (clean && clean.length <= 2000) comments.push(clean);
            }
          } catch { /* comments optional */ }
          comments = comments.slice(0, COMMENT_LIMIT);
          await writeFile(join(ARTICLES_DIR, a.id + '.json'), JSON.stringify({ id: a.id, publishedAt: a.publishedAt, posts, comments }));
          stats.bodiesNew++; stats.comments += comments.length;
        } else {
          const { text, finalUrl } = await fetchText(a.url);
          const root = parseHTML(text);
          const pageTime = extractPublishedAt(root, text);
          if (pageTime && (!a.publishedAt || Math.abs(pageTime - a.publishedAt) > 60000)) a.publishedAt = pageTime;
          const feed = extractFeedUrl(root, finalUrl);
          if (feed && !feedUrlByBlog.has(a.blogKey)) feedUrlByBlog.set(a.blogKey, feed);
          const posts = extractBody(root, finalUrl);
          const comments = extractComments(root);
          if (!posts.length) throw new Error('empty body');
          await writeFile(join(ARTICLES_DIR, a.id + '.json'), JSON.stringify({ id: a.id, publishedAt: a.publishedAt, posts, comments }));
          stats.bodiesNew++; stats.comments += comments.length;
        }
      } catch (e) {
        stats.failed.push(`body ${a.url}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));

  /* 6) ブログ別アーカイブ拡充 (各ブログ自身のフィード・4並列) */
  const feedTargets = [...blogs.values()].filter(b => !b.pinned);
  let feedCursor = 0;
  const feedWorker = async () => {
  while (feedCursor < feedTargets.length) {
    const b = feedTargets[feedCursor++];
    const mine = [...articles.values()].filter(a => a.blogKey === b.key);
    if (mine.length >= ARCHIVE_PER_BLOG) continue;
    let items = null;
    const known = feedUrlByBlog.get(b.key);
    if (known) items = await tryFeed(known);
    if (!items && mine[0]) {
      try {
        const { text, finalUrl } = await fetchText(mine[0].url, 12000);
        const f = extractFeedUrl(parseHTML(text), finalUrl);
        if (f) items = await tryFeed(f);
      } catch { /* ignore */ }
    }
    if (!items) {
      for (const cand of ['index.rdf', 'atom.xml', 'rss', 'feed']) {
        items = await tryFeed(new URL(cand, b.url.endsWith('/') ? b.url : b.url + '/').href);
        if (items) break;
      }
    }
    if (items) for (const it of items.slice(0, ARCHIVE_PER_BLOG)) addArticle(b.key, it.title, it.url, it.publishedAt);
    else stats.failed.push(`feed ${b.name}: not found`);
  }
  };
  await Promise.all(Array.from({ length: 4 }, feedWorker));

  /* 7) index.json 出力 */
  const finalBodies = new Set();
  for (const f of await readdir(ARTICLES_DIR)) if (f.endsWith('.json')) finalBodies.add(f.replace('.json', ''));
  const outArticles = [...articles.values()]
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .map(a => ({ ...a, hasBody: finalBodies.has(a.id) }));
  const outBlogs = [...blogs.values()].sort((x, y) => (y.pinned ? 1 : 0) - (x.pinned ? 1 : 0));
  const index = { generatedAt: new Date().toISOString(), blogs: outBlogs, articles: outArticles };
  await writeFile(join(DATA_DIR, 'index.json'), JSON.stringify(index));
  stats.blogs = outBlogs.length; stats.articles = outArticles.length; stats.bodies = outArticles.filter(a => a.hasBody).length;
  log('DONE', JSON.stringify({ blogs: stats.blogs, articles: stats.articles, bodies: stats.bodies, bodiesNew: stats.bodiesNew, commentsTotal: stats.comments, failedCount: stats.failed.length }));
  for (const f of stats.failed.slice(0, 40)) log('FAILED:', f);
}
main().catch(e => { console.error('[fetch] fatal', e); process.exit(1); });
