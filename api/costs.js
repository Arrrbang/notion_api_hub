// backend/costs.js

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ────────────────────────────────
// 환경변수 & 노션 공통
// ────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// 속성명
const REGION_PROP     = process.env.REGION_PROP      || '지역';       
const COMPANY_PROP    = process.env.COMPANY_PROP     || '업체';       
const POE_PROP        = process.env.POE_PROP         || 'POE';        
const CARGO_PROP      = process.env.CARGO_PROP       || '화물타입';   
const BASIC_PROP      = process.env.BASIC_PROP       || '기본/추가';  
const ITEM_PROP       = process.env.ITEM_PROP        || '항목';       
const EXTRA_PROP      = process.env.EXTRA_PROP       || '참고사항';   
const FORMULA_PROP    = process.env.FORMULA_PROP     || '계산식';     
const DISPLAY_TYPE_PROP = process.env.DISPLAY_TYPE_PROP || '표시타입'; 
const CURRENCY_PROP   = '통화'; // [추가] 노션 통화 텍스트 속성명

// CONSOLE 계산용
const MIN_COST_PROP   = process.env.MIN_COST_PROP    || 'MIN COST';
const MIN_CBM_PROP    = process.env.MIN_CBM_PROP     || 'MIN CBM';
const PER_COST_PROP   = process.env.PER_COST_PROP    || 'PER CBM';

// 순서 정렬용
const ORDER_PROP      = process.env.ORDER_PROP       || '순서';

// db-map.json 위치
function loadDbMap() {
  const full = path.join(process.cwd(), 'config', 'db-map.json');
  try {
    const raw  = fs.readFileSync(full, 'utf8');
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
  if (!NOTION_TOKEN) {
    throw new Error('NOTION_API_KEY (또는 NOTION_TOKEN)이 없습니다.');
  }
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28',
  };
}

// ────────────────────────────────
// Notion helpers
// ────────────────────────────────
function getTextFromRich(arr) {
  const a = Array.isArray(arr) ? arr : [];
  return a.map(t => t?.plain_text || '').join('');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"]/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[m] || m));
}

function richTextToHtml(arr) {
  const a = Array.isArray(arr) ? arr : [];
  return a.map(t => {
    if (!t) return '';
    const ann = t.annotations || {};
    let txt = escapeHtml(t.plain_text || '');
    txt = txt.replace(/\n/g, '<br>');
    if (ann.bold)         txt = `<strong>${txt}</strong>`;
    if (ann.italic)       txt = `<em>${txt}</em>`;
    if (ann.underline)    txt = `<u>${txt}</u>`;
    if (ann.strikethrough)txt = `<s>${txt}</s>`;
    if (ann.code)         txt = `<code>${txt}</code>`;
    const href = t.href || t.text?.link?.url;
    if (href) {
      const safeHref = String(href).replace(/"/g, '&quot;');
      txt = `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
    }
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

function getSelectName(prop) {
  if (!prop || prop.type !== 'select') return '';
  return prop.select?.name || '';
}

function getMultiSelectNames(prop) {
  if (!prop || prop.type !== 'multi_select') return [];
  return (prop.multi_select || []).map(o => o?.name).filter(Boolean);
}

function getNumberFromProp(prop) {
  if (!prop) return undefined;
  if (typeof prop === 'number') return prop;
  if (typeof prop.number === 'number') return prop.number;
  if (typeof prop.value === 'number')  return prop.value;
  return undefined;
}

// [추가] 1~28 CBM 직접 입력 속성 확인 함수
function getDirectCbmAmount(props, cbm) {
  if (!Number.isFinite(cbm) || cbm < 1 || cbm > 28) return undefined;
  const cbmKey = Math.floor(cbm).toString(); 
  const prop = props[cbmKey]; 
  if (prop) {
    const val = getNumberFromProp(prop);
    if (Number.isFinite(val)) return val;
  }
  return undefined;
}

function getOrderNumber(page) {
  const props = page.properties || {};
  const col   = props[ORDER_PROP];
  const n     = getNumberFromProp(col);
  const num   = Number(n);
  return Number.isFinite(num) ? num : 999999;
}

// 페이지네이션 전체 읽기
async function queryAllPages(dbId, body) {
  let all = [];
  let hasMore = true;
  let cursor = undefined;
  while (hasMore) {
    const payload = { ...body };
    if (cursor) payload.start_cursor = cursor;
    const resp = await axios.post(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      payload, { headers: notionHeaders() }
    );
    const data = resp.data;
    all.push(...(data.results || []));
    hasMore = data.has_more;
    cursor  = data.next_cursor;
  }
  return all;
}

async function queryAllDatabases(dbIds, body) {
  const out = [];
  for (const id of dbIds) {
    const pages = await queryAllPages(id, body);
    out.push(...pages);
  }
  return out;
}

// ────────────────────────────────
// 필터 매칭 로직
// ────────────────────────────────
function isRegionMatch(regionNames, selectedRegion) {
  if (!selectedRegion) return true;
  if (!regionNames.length) return true; 
  return regionNames.includes(selectedRegion);
}
function isCompanyMatch(companyName, selectedCompany) {
  if (!selectedCompany) return true;
  if (!companyName) return false;
  return companyName === selectedCompany;
}
function isPoeMatch(poeNames, selectedPoe) {
  if (!selectedPoe) return true;
  if (!poeNames.length) return false;
  return poeNames.includes(selectedPoe);
}
function isCargoMatch(cargoNames, roles) {
  if (!roles.length) return true;
  if (!cargoNames.length) return true;
  return cargoNames.some(c => roles.includes(c));
}

// ────────────────────────────────
// 금액 계산 로직
// ────────────────────────────────
function calcConsoleAmount(props, cbm) {
  const minCost = getNumberFromProp(props[MIN_COST_PROP]);
  const minCbm  = getNumberFromProp(props[MIN_CBM_PROP]);
  const perCost = getNumberFromProp(props[PER_COST_PROP]);
  if (!Number.isFinite(cbm) || !Number.isFinite(minCost) || 
      !Number.isFinite(minCbm) || !Number.isFinite(perCost)) return undefined;
  if (cbm <= minCbm) return minCost;
  return minCost + (cbm - minCbm) * perCost;
}

function getFormulaText(props, key) {
  const col = props?.[key];
  if (!col) return '';
  if (col.type === 'rich_text') return getTextFromRich(col.rich_text);
  if (col.type === 'title') return getTextFromRich(col.title);
  return String(col?.plain_text || '');
}

function evalFormula(code, context) {
  if (!code) return undefined;
  let expr = String(code).trim();
  const safe = /^[0-9+\-*/().\sCBMcbmMAXMIN,<>?=:]+$/i;
  if (!safe.test(expr)) return undefined;
  const cbmVal = Number(context?.cbm ?? 0);
  expr = expr.replace(/CBM/gi, String(cbmVal));
  expr = expr.replace(/MAX/gi, 'Math.max');
  expr = expr.replace(/MIN/gi, 'Math.min');
  try {
    const fn = new Function('"use strict"; return (' + expr + ');');
    const val = fn();
    return Number.isFinite(val) ? val : undefined;
  } catch (e) {
    return undefined;
  }
}

function evalRangeFormula(code, cbm) {
  if (!code) return undefined;

  // 1. IF문 처리 과정에서 생긴 외곽 괄호 제거
  // 예: "( rule1 \n rule2 )" -> "rule1 \n rule2"
  let clean = code.trim();
  while (clean.startsWith('(') && clean.endsWith(')')) {
    // 단순 제거가 아니라 짝이 맞을 때만 제거 (안전장치)
    let depth = 0;
    let isPair = true;
    for (let i = 0; i < clean.length - 1; i++) {
      if (clean[i] === '(') depth++;
      else if (clean[i] === ')') depth--;
      if (depth === 0) { isPair = false; break; } // 중간에 닫혀버리면 외곽 괄호가 아님
    }
    if (isPair) clean = clean.slice(1, -1).trim();
    else break;
  }

  // 2. 줄바꿈(\n) 또는 쉼표(,)로 문장 분리
  const lines = clean.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  
  for (const line of lines) {
    // 라인별로 앞뒤에 남은 괄호 잔여물 제거 (정규식 매칭을 위해)
    // 예: "CBM<=20=100 )" -> "CBM<=20=100"
    const safeLine = line.replace(/^\(+|\)+$/g, '').trim();

    // 1. 범위 문법: "1 <= CBM <= 10 = 200"
    let m = safeLine.match(/^(\d+)\s*(?:<=|≤|<)\s*CBM\s*(?:<=|≤|<)\s*(\d+)\s*=\s*(.+)$/i);
    if (m) {
      const min = Number(m[1]);
      const max = Number(m[2]);
      if (cbm >= min && cbm <= max) return evalFormula(m[3].trim(), { cbm });
      continue;
    }

    // 2. 단일 조건 문법: "CBM <= 20 = 400"
    m = safeLine.match(/^CBM\s*(<=|>=|≤|≥|[<>]=?)\s*(\d+)\s*=\s*(.+)$/i);
    if (m) {
      const op = m[1];
      const num = Number(m[2]);
      const valExpr = m[3].trim();
      
      let match = false;
      if (op === '<' && cbm < num) match = true;
      else if (op === '>' && cbm > num) match = true;
      else if ((op === '<=' || op === '≤') && cbm <= num) match = true;
      else if ((op === '>=' || op === '≥') && cbm >= num) match = true;
      
      if (match) return evalFormula(valExpr, { cbm });
      continue;
    }

    // 3. IF 문법 (중첩된 경우)
    m = safeLine.match(/^IF\s+CBM\s*(<=|>=|≤|≥|[<>]=?)\s*(\d+)\s+THEN\s+(\d+)/i);
    if (m) {
      const op = m[1];
      const num = Number(m[2]);
      const val = Number(m[3]);
      
      let match = false;
      if (op === '<' && cbm < num) match = true;
      else if (op === '>' && cbm > num) match = true;
      else if ((op === '<=' || op === '≤') && cbm <= num) match = true;
      else if ((op === '>=' || op === '≥') && cbm >= num) match = true;

      if (match) return val;
      continue;
    }

    // 4. ELSE 문법
    m = safeLine.match(/^ELSE\s+(\d+)/i);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function applyRegionFormula(code, selectedRegion, baseAmount, cbm) {
  if (!code) return code;
  let expr = String(code).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const regionVal = (selectedRegion || '').trim();
  const defaultVal = Number.isFinite(baseAmount) ? baseAmount : 0;
  expr = expr.replace(/\bDEFAULT\b/gi, String(defaultVal));
  const ifRegex = /IF\(\s*REGION\s*=\s*("([^"]*)"|'([^']*)')\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)/i;
  let changed = true;
  while (changed) {
    changed = false;
    expr = expr.replace(ifRegex, function (match, quoted, dbl, sgl, thenPart, elsePart) {
      changed = true;
      const target = (dbl || sgl || '').trim();
      const cond   = regionVal && regionVal === target;
      return cond ? '(' + thenPart.trim() + ')' : '(' + elsePart.trim() + ')';
    });
  }
  return expr;
}

function applyTypeFormula(code, currentType) {
  if (!code) return code;
  let expr = String(code);
  const typeVal = (currentType || '').toUpperCase();
  while (true) {
    const match = expr.match(/IF\(\s*TYPE\s*=\s*(?:'([^']*)'|"([^"]*)")\s*,/i);
    if (!match) break;
    const startIndex = match.index;
    const matchedStr = match[0];
    const targetType = (match[1] || match[2] || '').toUpperCase();
    let depth = 0; let splitIndex = -1; let endIndex = -1;
    const scanStart = startIndex + matchedStr.length;
    for (let i = scanStart; i < expr.length; i++) {
      const char = expr[i];
      if (char === '(') depth++;
      else if (char === ')') { if (depth === 0) { endIndex = i; break; } depth--; }
      else if (char === ',' && depth === 0) { if (splitIndex === -1) splitIndex = i; }
    }
    if (endIndex === -1) break; 
    let thenPart = '', elsePart = '';
    if (splitIndex !== -1) { thenPart = expr.substring(scanStart, splitIndex); elsePart = expr.substring(splitIndex + 1, endIndex); }
    else { thenPart = expr.substring(scanStart, endIndex); }
    const replacement = (typeVal === targetType) ? `(${thenPart})` : `(${elsePart})`;
    expr = expr.substring(0, startIndex) + replacement + expr.substring(endIndex + 1);
  }
  return expr;
}

// [수정] 메인 계산 함수 (1~28 CBM 최우선 순위 반영)
function computeAmount(props, type, cbm, selectedRegion) {
  let amount;

  // 1순위: 1~28 CBM 직접 입력 속성 확인
  const directAmount = getDirectCbmAmount(props, cbm);
  if (directAmount !== undefined) return directAmount;

  // 2순위: 컨테이너별/CONSOLE 기본 계산
  const val20 = getNumberFromProp(props['20FT']);
  const val40 = getNumberFromProp(props['40HC']);
  const consoleAmt = calcConsoleAmount(props, cbm);
  const hasBaseCost = Number.isFinite(val20) || Number.isFinite(val40) || Number.isFinite(consoleAmt);

  if (type === '20FT') {
    amount = Number.isFinite(val20) ? val20 : consoleAmt;
  } else if (type === '40HC') {
    amount = Number.isFinite(val40) ? val40 : consoleAmt;
  } else {
    amount = consoleAmt;
  }

  // 3순위: 계산식(Formula) 적용
  const baseAmount = amount;
  const rawFormula = getFormulaText(props, FORMULA_PROP);
  const shouldUseFormula = rawFormula && (!hasBaseCost || /REGION\b|DEFAULT\b|TYPE\b/i.test(rawFormula));

  if (shouldUseFormula) {
    let code = applyRegionFormula(rawFormula, selectedRegion || '', baseAmount, cbm);
    code = applyTypeFormula(code, type); 
    let v = evalRangeFormula(code, cbm);
    if (!Number.isFinite(v)) v = evalFormula(code, { cbm });
    if (Number.isFinite(v)) amount = v;
  }
  return amount;
}

// ────────────────────────────────
// 라우트 등록
// ────────────────────────────────
function registerCostsRoutes(app) {

  app.get('/api/companies/by-region', async (req, res) => {
    try {
      const country = (req.query.country || '').trim();
      const region  = (req.query.region  || '').trim();
      const dbIds = getCountryDbIds(country);
      if (!dbIds.length) return res.json({ companies: [] });
      const body = { page_size: 100 };
      if (region) body.filter = { property: REGION_PROP, multi_select: { contains: region } };
      const pages = await queryAllDatabases(dbIds, body);
      const set = new Set();
      for (const p of pages) {
        const props = p.properties || {};
        if (region && !isRegionMatch(getMultiSelectNames(props[REGION_PROP]), region)) continue;
        const cName = getSelectName(props[COMPANY_PROP]);
        if (cName) set.add(cName);
      }
      return res.json({ companies: [...set].sort() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/poe/by-company', async (req, res) => {
    try {
      const country = (req.query.country || '').trim();
      const region  = (req.query.region  || '').trim();
      const company = (req.query.company || '').trim();
      const dbIds = getCountryDbIds(country);
      if (!dbIds.length) return res.json({ poes: [] });
      const body = { page_size: 100 };
      const filters = [];
      if (region) filters.push({ property: REGION_PROP, multi_select: { contains: region } });
      if (company) filters.push({ property: COMPANY_PROP, select: { equals: company } });
      if (filters.length > 0) body.filter = { and: filters };
      const pages = await queryAllDatabases(dbIds, body);
      const set = new Set();
      for (const p of pages) {
        const props = p.properties || {};
        if (region && !isRegionMatch(getMultiSelectNames(props[REGION_PROP]), region)) continue;
        if (company && !isCompanyMatch(getSelectName(props[COMPANY_PROP]), company)) continue;
        getMultiSelectNames(props[POE_PROP]).forEach(poe => set.add(poe));
      }
      return res.json({ poes: [...set].sort() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/cargo-types/by-partner', async (req, res) => {
    try {
      const country = (req.query.country || '').trim();
      const company = (req.query.company || '').trim();
      const poe     = (req.query.poe     || '').trim();
      const dbIds = getCountryDbIds(country);
      if (!dbIds.length) return res.json({ types: [] });
      const body = { page_size: 100 };
      const filters = [];
      if (company) filters.push({ property: COMPANY_PROP, select: { equals: company } });
      if (poe) filters.push({ property: POE_PROP, multi_select: { contains: poe } });
      if (filters.length > 0) body.filter = { and: filters };
      const pages = await queryAllDatabases(dbIds, body);
      const set = new Set();
      for (const p of pages) {
        const props = p.properties || {};
        if (company && !isCompanyMatch(getSelectName(props[COMPANY_PROP]), company)) continue;
        if (poe && !isPoeMatch(getMultiSelectNames(props[POE_PROP]), poe)) continue;
        getMultiSelectNames(props[CARGO_PROP]).forEach(t => set.add(t));
      }
      return res.json({ types: [...set].sort() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // [수정] 메인 비용 조회 라우터 (통화 속성 동적 감지 추가)
  app.get('/api/costs/:country', async (req, res) => {
    try {
      const country = (req.params.country || '').trim();
      const region  = (req.query.region  || '').trim();
      const company = (req.query.company || '').trim();
      const poe     = (req.query.poe     || '').trim();
      const typeRaw = (req.query.type    || '20FT').trim().toUpperCase();
      const type    = (typeRaw === 'CONSOLE' ? 'CONSOLE' : typeRaw === '40HC' ? '40HC' : '20FT');
      const cbm     = req.query.cbm != null ? Number(req.query.cbm) : NaN;
      const rolesParam = (req.query.roles || '').trim();
      const roles   = rolesParam ? rolesParam.split(',').map(s => s.trim()).filter(Boolean) : [];

      const dbIds = getCountryDbIds(country);
      if (!dbIds.length) return res.json({ ok: true, country, rows: [], currency: 'USD' });

      const body = { page_size: 100, sorts: [{ property: ORDER_PROP, direction: 'ascending' }] };
      const filters = [];
      if (region) filters.push({ or: [{ property: REGION_PROP, multi_select: { contains: region } }, { property: REGION_PROP, multi_select: { is_empty: true } }] });
      if (company) filters.push({ property: COMPANY_PROP, select: { equals: company } });
      if (poe) filters.push({ property: POE_PROP, multi_select: { contains: poe } });
      if (filters.length > 0) body.filter = { and: filters };

      const pages = await queryAllDatabases(dbIds, body);
      const rows = [];
      let detectedCurrency = 'USD'; // [추가] 통화 감지용 변수

      for (const page of pages) {
        const props = page.properties || {};
        
        // [추가] 행별 "통화" 속성 읽기 및 전역 통화 설정
        const curProp = props[CURRENCY_PROP];
        if (curProp && curProp.type === 'rich_text') {
            const curVal = getTextFromRich(curProp.rich_text).trim().toUpperCase();
            if (curVal && detectedCurrency === 'USD') detectedCurrency = curVal;
        }

        const regionNames = getMultiSelectNames(props[REGION_PROP]);
        const companyName = getSelectName(props[COMPANY_PROP]);
        const poeNames    = getMultiSelectNames(props[POE_PROP]);
        const cargoNames  = getMultiSelectNames(props[CARGO_PROP]);

        if (region && !regionNames.includes(region) && regionNames.length > 0) continue;
        if (!isCompanyMatch(companyName, company)) continue;
        if (!isPoeMatch(poeNames, poe)) continue;
        if (!isCargoMatch(cargoNames, roles)) continue;

        const amount = computeAmount(props, type, cbm, region);
        rows.push({
          id: page.id,
          item: getTitle(props, ITEM_PROP) || getTitle(props, 'Name') || '',
          basicType: getSelectName(props[BASIC_PROP]) || '',
          displayType: getSelectName(props[DISPLAY_TYPE_PROP]) || '',
          order: getOrderNumber(page),
          [type]: amount ?? null,
          extra: getRichTextHtml(props, EXTRA_PROP) || '',
        });
      }

      rows.sort((a, b) => a.order - b.order);

      // [수정] 감지된 통화를 JSON 결과에 포함
      return res.json({
        ok: true, country, type, rows, numberFormats: {}, currency: detectedCurrency,
      });

    } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'failed' }); }
  });
}

module.exports = registerCostsRoutes;
