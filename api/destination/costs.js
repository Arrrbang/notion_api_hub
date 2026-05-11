// backend/costs.js - 통합 및 최적화 최종 버전 (유동적 CBM 계산 & 타입 속성 통합 반영)

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ────────────────────────────────
// 환경변수 & 노션 공통 설정
// ────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// 속성명 설정 (기본/추가, 표시타입 제거 및 '타입'으로 통합)
const REGION_PROP       = process.env.REGION_PROP       || '지역';       
const COMPANY_PROP      = process.env.COMPANY_PROP      || '업체';       
const POE_PROP          = process.env.POE_PROP          || 'POE';        
const CARGO_PROP        = process.env.CARGO_PROP        || '화물타입';   
const ROW_TYPE_PROP     = process.env.ROW_TYPE_PROP     || '타입';       // ✨ 통합된 속성
const ITEM_PROP         = process.env.ITEM_PROP         || '항목';       
const EXTRA_PROP        = process.env.EXTRA_PROP        || '참고사항';   
const FORMULA_PROP      = process.env.FORMULA_PROP      || '계산식';     
const CURRENCY_PROP     = '통화';

// 1~28 CBM 직접 입력 속성명 배열 생성
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

function getDynamicCbmAmount(props, cbm, rawFormula = '') {
  if (!Number.isFinite(cbm)) return undefined;

  // 1. ✨ 'LOOP_35' 키워드가 있을 때의 특수 로직
  if (rawFormula.includes('LOOP_35')) {
    const val28 = getNumberFromProp(props['28']);
    const perCost = getNumberFromProp(props[PER_COST_PROP]);

    // 28 CBM 값과 PER CBM 값이 모두 있어야 계산 가능
    if (Number.isFinite(val28) && Number.isFinite(perCost)) {
      // 35 CBM일 때의 꽉 찬 요금 계산 = 28 CBM 요금 + (7 * PER CBM)
      const maxCost35 = val28 + (7 * perCost); 

      // 36 CBM 이상 구간: 35 CBM 꽉 찬 요금 + 나머지 CBM 요금 (재귀)
      if (cbm > 35) {
        const remainder = cbm - 35;
        // 남은 CBM에 대해 다시 이 함수를 태워서 1 CBM부터의 값을 구함
        const remainderVal = getDynamicCbmAmount(props, remainder, rawFormula); 
        
        if (Number.isFinite(remainderVal)) {
          return maxCost35 + remainderVal;
        }
      }

      // 28 초과 ~ 35 이하 구간: 28 CBM 요금 + 초과한 만큼의 PER CBM 가산
      if (cbm > 28 && cbm <= 35) {
        return val28 + ((cbm - 28) * perCost);
      }
    }
  }

  // 2. 1 ~ 28 CBM 직접 입력 구간 (LOOP_35 여부 상관없이 공통 처리)
  if (cbm >= 1 && cbm <= 28) {
    const exactVal = getNumberFromProp(props[Math.floor(cbm).toString()]);
    if (Number.isFinite(exactVal)) return exactVal;
  }

  // 3. LOOP_35가 아니거나(일반 항목), 28 CBM 이하에서 값이 누락된 경우 (기존 PER CBM 로직 유지)
  const perCostFallback = getNumberFromProp(props[PER_COST_PROP]);
  let highestFilledCbm = 0;
  let highestFilledCost = 0;

  const maxCheck = Math.min(Math.floor(cbm), 28);
  for (let i = maxCheck; i >= 1; i--) {
    const val = getNumberFromProp(props[i.toString()]);
    if (Number.isFinite(val)) {
      highestFilledCbm = i;
      highestFilledCost = val;
      break;
    }
  }

  if (highestFilledCbm > 0 && Number.isFinite(perCostFallback)) {
    return highestFilledCost + ((cbm - highestFilledCbm) * perCostFallback);
  }

  return undefined;
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
  let amount;

  // ✨ 수정: 계산식 값을 먼저 가져옵니다.
  const rawFormula = getTitle(props, FORMULA_PROP);

  // ✨ 수정: rawFormula를 파라미터로 넘겨줍니다.
  const dynamicAmount = getDynamicCbmAmount(props, cbm, rawFormula);
  if (dynamicAmount !== undefined) return dynamicAmount;

  const val20 = getNumberFromProp(props['20FT']);
  const val40 = getNumberFromProp(props['40HC']);
  const consoleAmt = calcConsoleAmount(props, cbm);
  const hasBaseCost = Number.isFinite(val20) || Number.isFinite(val40) || Number.isFinite(consoleAmt);

  if (type === '20FT') amount = val20 ?? consoleAmt;
  else if (type === '40HC') amount = val40 ?? consoleAmt;
  else amount = consoleAmt;

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
          rowType: getSelectName(props[ROW_TYPE_PROP]) || '', // ✨ 백엔드: CDS, ADD, TAX, OTC 전달
          order: getNumberFromProp(props[ORDER_PROP]) ?? 9999,
          [type]: computeAmount(props, type, cbm, region) ?? null,
          extra: getRichTextHtml(props, EXTRA_PROP) || '',
        };
      }).filter(Boolean).sort((a, b) => a.order - b.order);

      return res.json({ ok: true, country, type, rows, currency: detectedCurrency });
    } catch (e) { res.status(500).json({ ok: false, error: 'costs failed' }); }
  });

  app.get('/api/companies/by-region', async (req, res) => {
    // 생략 없이 기존 코드 유지
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
    // 생략 없이 기존 코드 유지
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
    // 생략 없이 기존 코드 유지
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
