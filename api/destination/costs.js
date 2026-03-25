// backend/costs.js - 통합 및 최적화 최종 버전

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ────────────────────────────────
// 환경변수 & 노션 공통 설정
// ────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// 속성명 설정
const REGION_PROP       = process.env.REGION_PROP       || '지역';       
const COMPANY_PROP      = process.env.COMPANY_PROP      || '업체';       
const POE_PROP          = process.env.POE_PROP          || 'POE';        
const CARGO_PROP        = process.env.CARGO_PROP        || '화물타입';   
const BASIC_PROP        = process.env.BASIC_PROP        || '기본/추가';  
const ITEM_PROP         = process.env.ITEM_PROP         || '항목';       
const EXTRA_PROP        = process.env.EXTRA_PROP        || '참고사항';   
const FORMULA_PROP      = process.env.FORMULA_PROP      || '계산식';     
const DISPLAY_TYPE_PROP = process.env.DISPLAY_TYPE_PROP || '표시타입'; 
const CURRENCY_PROP     = '통화';

// [destination.js 로직] 1~28 CBM 직접 입력 속성명 배열 생성
const CBM_DIRECT_PROPS = Array.from({ length: 28 }, (_, i) => (i + 1).toString());

// CONSOLE 및 순서 정렬용
const MIN_COST_PROP     = process.env.MIN_COST_PROP    || 'MIN COST';
const MIN_CBM_PROP      = process.env.MIN_CBM_PROP     || 'MIN CBM';
const PER_COST_PROP     = process.env.PER_COST_PROP    || 'PER CBM';
const ORDER_PROP        = process.env.ORDER_PROP       || '순서';

// ────────────────────────────────
// Notion 및 DB 유틸리티
// ────────────────────────────────
function loadDbMap() {
  const full = path.join(process.cwd(), 'config', 'db-map.json');
  try {
    const raw = fs.readFileSync(full, 'utf8');
    return JSON.parse(raw);
  } catch(e) { return {}; }
}

function getCountryDbIds(country) {
  const dbmap = loadDbMap();
  const v = dbmap?.[country];
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string') return [v];
  return [];
}

function notionHeaders() {
  if (!NOTION_TOKEN) throw new Error('NOTION_TOKEN이 없습니다.');
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28',
  };
}

// ────────────────────────────────
// Notion 속성 파싱 헬퍼
// ────────────────────────────────
function getTextFromRich(arr) {
  const a = Array.isArray(arr) ? arr : [];
  return a.map(t => t?.plain_text || '').join('');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] || m));
}

function richTextToHtml(arr) {
  const a = Array.isArray(arr) ? arr : [];
  return a.map(t => {
    if (!t) return '';
    const ann = t.annotations || {};
    let txt = escapeHtml(t.plain_text || '');
    txt = txt.replace(/\n/g, '<br>');
    if (ann.bold) txt = `<strong>${txt}</strong>`;
    if (ann.italic) txt = `<em>${txt}</em>`;
    if (ann.underline) txt = `<u>${txt}</u>`;
    if (ann.strikethrough) txt = `<s>${txt}</s>`;
    if (ann.code) txt = `<code>${txt}</code>`;
    const href = t.href || t.text?.link?.url;
    if (href) txt = `<a href="${String(href).replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
    return txt;
  }).join('');
}

function getRichTextHtml(props, key) {
  const col = props?.[key];
  if (!col) return '';
  if (col.type === 'rich_text') return richTextToHtml(col.rich_text);
  if (col.type === 'title') return richTextToHtml(col.title);
  return '';
}

function getTitle(props, key) {
  const col = props?.[key];
  if (!col) return '';
  if (col.type === 'title') return getTextFromRich(col.title);
  if (col.type === 'rich_text') return getTextFromRich(col.rich_text);
  return '';
}

function getSelectName(prop) { return prop?.select?.name || ''; }
function getMultiSelectNames(prop) { return (prop?.multi_select || []).map(o => o?.name).filter(Boolean); }

function getNumberFromProp(prop) {
  if (!prop) return undefined;
  if (typeof prop === 'number') return prop;
  if (typeof prop.number === 'number') return prop.number;
  if (typeof prop.value === 'number') return prop.value;
  return undefined;
}

// ────────────────────────────────
// [금액 계산 로직] destination.js의 1~28 및 29+ 로직 완전 통합
// ────────────────────────────────
function getDirectCbmAmount(props, cbm) {
  if (!Number.isFinite(cbm) || cbm < 1 || cbm > 28) return undefined;
  // CBM_DIRECT_PROPS 배열에 정의된 속성 키와 일치하는지 확인
  const cbmKey = Math.floor(cbm).toString();
  const prop = props[cbmKey];
  const val = getNumberFromProp(prop);
  return Number.isFinite(val) ? val : undefined;
}

function calcConsoleAmount(props, cbm) {
  const minCost = getNumberFromProp(props[MIN_COST_PROP]);
  const minCbm  = getNumberFromProp(props[MIN_CBM_PROP]);
  const perCost = getNumberFromProp(props[PER_COST_PROP]);
  if (!Number.isFinite(cbm) || !Number.isFinite(minCost) || !Number.isFinite(minCbm) || !Number.isFinite(perCost)) return undefined;
  if (cbm <= minCbm) return minCost;
  return minCost + (cbm - minCbm) * perCost;
}

function computeAmount(props, type, cbm, selectedRegion) {
  // 1순위: 1~28 CBM 직접 입력 (destination.js 로직)
  const directAmount = getDirectCbmAmount(props, cbm);
  if (directAmount !== undefined) return directAmount;

  // 2순위: CBM 29 이상일 때 (destination.js 로직)
  if (cbm > 28) {
    const val28 = getNumberFromProp(props['28']);
    const perCost = getNumberFromProp(props[PER_COST_PROP]);
    if (Number.isFinite(val28) && Number.isFinite(perCost)) return val28 + (cbm - 28) * perCost;
  }

  // 3순위: 컨테이너별/CONSOLE 기본 계산
  const val20 = getNumberFromProp(props['20FT']);
  const val40 = getNumberFromProp(props['40HC']);
  const consoleAmt = calcConsoleAmount(props, cbm);
  const hasBaseCost = Number.isFinite(val20) || Number.isFinite(val40) || Number.isFinite(consoleAmt);

  let amount;
  if (type === '20FT') amount = val20 ?? consoleAmt;
  else if (type === '40HC') amount = val40 ?? consoleAmt;
  else amount = consoleAmt;

  // 4순위: 계산식(Formula) 적용 (destination.js의 강화된 파싱 적용)
  const rawFormula = getTitle(props, FORMULA_PROP);
  const shouldUseFormula = rawFormula && (!hasBaseCost || /REGION\b|DEFAULT\b|TYPE\b/i.test(rawFormula));

  if (shouldUseFormula) {
    let code = applyRegionFormula(rawFormula, selectedRegion || '', amount, cbm);
    code = applyTypeFormula(code, type);
    let v = evalRangeFormula(code, cbm);
    if (!Number.isFinite(v)) v = evalFormula(code, { cbm });
    if (Number.isFinite(v)) amount = v;
  }
  return amount;
}

// ────────────────────────────────
// 수식 처리 엔진
// ────────────────────────────────
function evalFormula(code, context) {
  if (!code) return undefined;
  let expr = String(code).trim();
  const safe = /^[0-9+\-*/().\sCBMcbmMAXMIN,<>?=:]+$/i;
  if (!safe.test(expr.replace(/Math\.(max|min)/g, ''))) return undefined;
  expr = expr.replace(/CBM/gi, String(Number(context?.cbm ?? 0))).replace(/MAX/gi, 'Math.max').replace(/MIN/gi, 'Math.min');
  try { return new Function('"use strict"; return (' + expr + ');')(); } catch (e) { return undefined; }
}

function evalRangeFormula(code, cbm) {
  if (!code) return undefined;
  let clean = code.trim();
  while (clean.startsWith('(') && clean.endsWith(')')) {
    let depth = 0, isPair = true;
    for (let i = 0; i < clean.length - 1; i++) {
      if (clean[i] === '(') depth++; else if (clean[i] === ')') depth--;
      if (depth === 0) { isPair = false; break; }
    }
    if (isPair) clean = clean.slice(1, -1).trim(); else break;
  }
  const lines = clean.split(/[\n,]+/).map(s => s.trim().replace(/^\(+|\)+$/g, '')).filter(Boolean);
  for (const line of lines) {
    let m = line.match(/^(\d+)\s*(?:<=|≤|<)\s*CBM\s*(?:<=|≤|<)\s*(\d+)\s*=\s*(.+)$/i);
    if (m && cbm >= Number(m[1]) && cbm <= Number(m[2])) return evalFormula(m[3], { cbm });
    m = line.match(/^CBM\s*(<=|>=|≤|≥|[<>]=?)\s*(\d+)\s*=\s*(.+)$/i);
    if (m) {
      const op = m[1], num = Number(m[2]);
      if ((op === '<' && cbm < num) || (op === '>' && cbm > num) || ((op === '<=' || op === '≤') && cbm <= num) || ((op === '>=' || op === '≥') && cbm >= num)) return evalFormula(m[3], { cbm });
    }
    m = line.match(/^ELSE\s+(\d+)/i); if (m) return Number(m[1]);
  }
  return undefined;
}

function applyRegionFormula(code, region, base, cbm) {
  let expr = String(code).replace(/\bDEFAULT\b/gi, String(base || 0));
  const ifRegex = /IF\(\s*REGION\s*=\s*["']([^"']*)["']\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)/i;
  while (ifRegex.test(expr)) {
    expr = expr.replace(ifRegex, (m, target, thenP, elseP) => (region === target ? thenP : elseP));
  }
  return expr;
}

function applyTypeFormula(code, type) {
  let expr = String(code);
  const ifRegex = /IF\(\s*TYPE\s*=\s*["']([^"']*)["']\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)/i;
  while (ifRegex.test(expr)) {
    expr = expr.replace(ifRegex, (m, target, thenP, elseP) => (type.toUpperCase() === target.toUpperCase() ? thenP : elseP));
  }
  return expr;
}

// ────────────────────────────────
// API 라우터 등록
// ────────────────────────────────
function registerCostsRoutes(app) {
  app.get('/api/costs/:country', async (req, res) => {
    try {
      const country = (req.params.country || '').trim();
      const { region, company, poe, roles: rolesParam = '' } = req.query;
      const typeRaw = (req.query.type || '20FT').trim().toUpperCase();
      const type = (typeRaw === 'CONSOLE' || typeRaw === '40HC') ? typeRaw : '20FT';
      const cbm = req.query.cbm != null ? Number(req.query.cbm) : NaN;
      const roles = rolesParam ? rolesParam.split(',').map(s => s.trim()).filter(Boolean) : [];

      const dbIds = getCountryDbIds(country);
      if (!dbIds.length) return res.json({ ok: true, country, rows: [], currency: 'USD' });

      const filters = [];
      if (region) filters.push({ or: [{ property: REGION_PROP, multi_select: { contains: region } }, { property: REGION_PROP, multi_select: { is_empty: true } }] });
      if (company) filters.push({ property: COMPANY_PROP, select: { equals: company } });
      if (poe) filters.push({ property: POE_PROP, multi_select: { contains: poe } });

      const pages = [];
      for (const id of dbIds) {
        let hasMore = true, cursor;
        while (hasMore) {
          const resp = await axios.post(`https://api.notion.com/v1/databases/${id}/query`, { 
            page_size: 100, filter: filters.length ? { and: filters } : undefined, start_cursor: cursor 
          }, { headers: notionHeaders() });
          pages.push(...(resp.data.results || []));
          hasMore = resp.data.has_more; cursor = resp.data.next_cursor;
        }
      }

      let detectedCurrency = 'USD';
      const rows = pages.map(page => {
        const props = page.properties || {};
        const curProp = props[CURRENCY_PROP];
        if (curProp?.rich_text?.length) {
          const val = getTextFromRich(curProp.rich_text).trim().toUpperCase();
          if (val) detectedCurrency = val;
        }

        const rNames = getMultiSelectNames(props[REGION_PROP]), cName = getSelectName(props[COMPANY_PROP]);
        const pNames = getMultiSelectNames(props[POE_PROP]), cargoNames = getMultiSelectNames(props[CARGO_PROP]);

        if (region && rNames.length > 0 && !rNames.includes(region)) return null;
        if (company && cName !== company) return null;
        if (poe && !pNames.includes(poe)) return null;
        if (roles.length && !cargoNames.some(c => roles.includes(c))) return null;

        return {
          id: page.id,
          item: getTitle(props, ITEM_PROP) || getTitle(props, 'Name') || '',
          basicType: getSelectName(props[BASIC_PROP]) || '',
          displayType: getSelectName(props[DISPLAY_TYPE_PROP]) || '',
          order: getNumberFromProp(props[ORDER_PROP]) ?? 9999,
          [type]: computeAmount(props, type, cbm, region) ?? null,
          extra: getRichTextHtml(props, EXTRA_PROP) || '',
        };
      }).filter(Boolean).sort((a, b) => a.order - b.order);

      return res.json({ ok: true, country, type, rows, currency: detectedCurrency });
    } catch (e) { res.status(500).json({ ok: false, error: 'costs failed' }); }
  });

  // 기타 목록 조회 API들
  app.get('/api/companies/by-region', async (req, res) => {
    try {
      const { country, region } = req.query;
      const dbIds = getCountryDbIds(country);
      if (!dbIds.length) return res.json({ companies: [] });
      const body = region ? { filter: { property: REGION_PROP, multi_select: { contains: region } } } : {};
      const pages = [];
      for (const id of dbIds) {
        const resp = await axios.post(`https://api.notion.com/v1/databases/${id}/query`, body, { headers: notionHeaders() });
        pages.push(...resp.data.results);
      }
      const set = new Set();
      pages.forEach(p => { const name = getSelectName(p.properties[COMPANY_PROP]); if(name) set.add(name); });
      res.json({ companies: Array.from(set).sort() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/poe/by-company', async (req, res) => {
    try {
      const { country, region, company } = req.query;
      const dbIds = getCountryDbIds(country);
      const filters = [];
      if (region) filters.push({ property: REGION_PROP, multi_select: { contains: region } });
      if (company) filters.push({ property: COMPANY_PROP, select: { equals: company } });
      const pages = [];
      for (const id of dbIds) {
        const resp = await axios.post(`https://api.notion.com/v1/databases/${id}/query`, { filter: filters.length ? { and: filters } : undefined }, { headers: notionHeaders() });
        pages.push(...resp.data.results);
      }
      const set = new Set();
      pages.forEach(p => getMultiSelectNames(p.properties[POE_PROP]).forEach(poe => set.add(poe)));
      res.json({ poes: Array.from(set).sort() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/cargo-types/by-partner', async (req, res) => {
    try {
      const { country, company, poe } = req.query;
      const dbIds = getCountryDbIds(country);
      const filters = [];
      if (company) filters.push({ property: COMPANY_PROP, select: { equals: company } });
      if (poe) filters.push({ property: POE_PROP, multi_select: { contains: poe } });
      const pages = [];
      for (const id of dbIds) {
        const resp = await axios.post(`https://api.notion.com/v1/databases/${id}/query`, { filter: filters.length ? { and: filters } : undefined }, { headers: notionHeaders() });
        pages.push(...resp.data.results);
      }
      const set = new Set();
      pages.forEach(p => getMultiSelectNames(p.properties[CARGO_PROP]).forEach(t => set.add(t)));
      res.json({ types: Array.from(set).sort() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = registerCostsRoutes;
