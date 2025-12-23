// backend/costs.js

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ────────────────────────────────
// 환경변수 & 노션 공통
// ────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// 속성명
const REGION_PROP     = process.env.REGION_PROP      || '지역';       // multi_select
const COMPANY_PROP    = process.env.COMPANY_PROP     || '업체';       // select
const POE_PROP        = process.env.POE_PROP         || 'POE';        // multi_select
const CARGO_PROP      = process.env.CARGO_PROP       || '화물타입';   // multi_select
const BASIC_PROP      = process.env.BASIC_PROP       || '기본/추가';  // select
const ITEM_PROP       = process.env.ITEM_PROP        || '항목';       // title
const EXTRA_PROP      = process.env.EXTRA_PROP       || '참고사항';   // rich_text
const FORMULA_PROP    = process.env.FORMULA_PROP     || '계산식';     
const DISPLAY_TYPE_PROP = process.env.DISPLAY_TYPE_PROP || '표시타입'; 

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
// 필터 매칭 로직 (메모리상 2차 검증)
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

  // 1. 보안 검사 (허용 문자 목록 확장: MAX, MIN, 쉼표 포함)
  const safe = /^[0-9+\-*/().\sCBMcbmMAXMIN,<>?=:]+$/i;

  if (!safe.test(expr)) {
    return undefined;
  }

  const cbmVal = Number(context?.cbm ?? 0);

  // 2. CBM 값 치환
  expr = expr.replace(/CBM/gi, String(cbmVal));

  // 3. 엑셀식 함수(MAX, MIN)를 자바스크립트 함수(Math.max, Math.min)로 변환
  expr = expr.replace(/MAX/gi, 'Math.max');
  expr = expr.replace(/MIN/gi, 'Math.min');

  try {
    // 4. 수식 계산 실행
    const fn = new Function('"use strict"; return (' + expr + ');');
    const val = fn();
    return Number.isFinite(val) ? val : undefined;
  } catch (e) {
    return undefined;
  }
}

// [최종] 범위 목록 처리 함수 (쉼표 구분 지원, <= 등 특수기호 지원)
function evalRangeFormula(code, cbm) {
  if (!code) return undefined;

  // ─────────────────────────────────────────────────────────────
  // [수정 포인트] 줄바꿈(\n) 뿐만 아니라 쉼표(,)로도 문장을 나눕니다.
  // 예: "1<=CBM<=10=200, 11<=CBM<=20=300" -> 두 개의 규칙으로 인식
  // ─────────────────────────────────────────────────────────────
  const lines = code.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  
  for (const line of lines) {
    // 1. 범위 문법: "1 <= CBM <= 10 = 200"
    let m = line.match(/^(\d+)\s*(?:<=|≤|<)\s*CBM\s*(?:<=|≤|<)\s*(\d+)\s*=\s*(.+)$/i);
    if (m) {
      const min = Number(m[1]);
      const max = Number(m[2]);
      if (cbm >= min && cbm <= max) return evalFormula(m[3].trim(), { cbm });
      continue;
    }

    // 2. 단일 조건 문법: "CBM <= 20 = 400"
    m = line.match(/^CBM\s*(<=|>=|≤|≥|[<>]=?)\s*(\d+)\s*=\s*(.+)$/i);
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

    // 3. IF 문법: "IF CBM > 20 THEN 400"
    m = line.match(/^IF\s+CBM\s*(<=|>=|≤|≥|[<>]=?)\s*(\d+)\s+THEN\s+(\d+)/i);
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

    // 4. ELSE 문법: "ELSE 500"
    m = line.match(/^ELSE\s+(\d+)/i);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function applyRegionFormula(code, selectedRegion, baseAmount, cbm) {
  if (!code) return code;
  let expr = String(code).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const regionVal  = (selectedRegion || '').trim();
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
    let depth = 0;
    let splitIndex = -1;
    let endIndex = -1;
    const scanStart = startIndex + matchedStr.length;
    for (let i = scanStart; i < expr.length; i++) {
      const char = expr[i];
      if (char === '(') depth++;
      else if (char === ')') {
        if (depth === 0) { endIndex = i; break; }
        depth--;
      } else if (char === ',' && depth === 0) {
        if (splitIndex === -1) splitIndex = i;
      }
    }
    if (endIndex === -1) break; 
    let thenPart = '', elsePart = '';
    if (splitIndex !== -1) {
      thenPart = expr.substring(scanStart, splitIndex);
      elsePart = expr.substring(splitIndex + 1, endIndex);
    } else {
      thenPart = expr.substring(scanStart, endIndex);
    }
    const replacement = (typeVal === targetType) ? `(${thenPart})` : `(${elsePart})`;
    expr = expr.substring(0, startIndex) + replacement + expr.substring(endIndex + 1);
  }
  return expr;
}

function computeAmount(props, type, cbm, selectedRegion) {
  let amount;
  const val20 = getNumberFromProp(props['20FT']);
  const val40 = getNumberFromProp(props['40HC']);
  const consoleAmt = calcConsoleAmount(props, cbm);
  const hasBaseCost = Number.isFinite(val20) || Number.isFinite(val40) || Number.isFinite(consoleAmt);

  if (type === '20FT') {
    if (Number.isFinite(val20)) amount = val20;
    else if (Number.isFinite(consoleAmt)) amount = consoleAmt;
  } else if (type === '40HC') {
    if (Number.isFinite(val40)) amount = val40;
    else if (Number.isFinite(consoleAmt)) amount = consoleAmt;
  } else {
    if (Number.isFinite(consoleAmt)) amount = consoleAmt;
  }

  const baseAmount = amount;
  const rawFormula = getFormulaText(props, FORMULA_PROP);
  const shouldUseFormula = rawFormula && (!hasBaseCost || /REGION\b|DEFAULT\b|TYPE\b/i.test(rawFormula));

  if (shouldUseFormula) {
    const regionStr = selectedRegion || '';
    let code = applyRegionFormula(rawFormula, regionStr, baseAmount, cbm);
    code = applyTypeFormula(code, type); 
    let v = evalRangeFormula(code, cbm);
    if (!Number.isFinite(v)) v = evalFormula(code, { cbm });
    if (Number.isFinite(v)) amount = v;
  }
  return amount;
}


// ────────────────────────────────
// [핵심] 라우트 등록
// ────────────────────────────────
function registerCostsRoutes(app) {

  /**
   * 1. 업체 목록 (지역 필터 적용)
   * GET /api/companies/by-region?country=...&region=...
   */
  app.get('/api/companies/by-region', async (req, res) => {
    try {
      const country = (req.query.country || '').trim();
      const region  = (req.query.region  || '').trim();
      
      const dbIds = getCountryDbIds(country);
      if (!dbIds.length) return res.json({ companies: [] });

      // ★ 필터 적용: 지역이 일치하는 데이터만 가져옴 (속도 최적화)
      const body = { page_size: 100 };
      if (region) {
        body.filter = {
          property: REGION_PROP,
          multi_select: { contains: region }
        };
      }

      const pages = await queryAllDatabases(dbIds, body);
      
      // 중복 제거하여 업체명 추출
      const set = new Set();
      for (const p of pages) {
        const props = p.properties || {};
        // 지역 2차 검증
        const rNames = getMultiSelectNames(props[REGION_PROP]);
        if (region && !isRegionMatch(rNames, region)) continue;

        const cName = getSelectName(props[COMPANY_PROP]);
        if (cName) set.add(cName);
      }
      
      return res.json({ companies: [...set].sort() });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });


  /**
   * 2. POE 목록 (지역 + 업체 필터 적용)
   * GET /api/poe/by-company?country=...&region=...&company=...
   */
  app.get('/api/poe/by-company', async (req, res) => {
    try {
      const country = (req.query.country || '').trim();
      const region  = (req.query.region  || '').trim();
      const company = (req.query.company || '').trim();

      const dbIds = getCountryDbIds(country);
      if (!dbIds.length) return res.json({ poes: [] });

      // ★ 필터 적용: 지역 & 업체 동시 필터링
      const body = { page_size: 100 };
      const filters = [];
      
      if (region) {
        filters.push({
          property: REGION_PROP,
          multi_select: { contains: region }
        });
      }
      if (company) {
        filters.push({
          property: COMPANY_PROP,
          select: { equals: company }
        });
      }

      if (filters.length > 0) {
        body.filter = { and: filters };
      }

      const pages = await queryAllDatabases(dbIds, body);
      
      const set = new Set();
      for (const p of pages) {
        const props = p.properties || {};
        // 2차 검증
        const rNames = getMultiSelectNames(props[REGION_PROP]);
        const cName  = getSelectName(props[COMPANY_PROP]);

        if (region && !isRegionMatch(rNames, region)) continue;
        if (company && !isCompanyMatch(cName, company)) continue;

        const pNames = getMultiSelectNames(props[POE_PROP]);
        pNames.forEach(poe => set.add(poe));
      }
      return res.json({ poes: [...set].sort() });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * 3. 화물타입 목록 (업체 + POE 필터 적용)
   * GET /api/cargo-types/by-partner?country=...&company=...&poe=...
   */
  app.get('/api/cargo-types/by-partner', async (req, res) => {
    try {
      const country = (req.query.country || '').trim();
      const company = (req.query.company || '').trim();
      const poe     = (req.query.poe     || '').trim();

      const dbIds = getCountryDbIds(country);
      if (!dbIds.length) return res.json({ types: [] });

      const body = { page_size: 100 };
      const filters = [];

      if (company) {
        filters.push({
          property: COMPANY_PROP,
          select: { equals: company }
        });
      }
      // POE는 보통 multi_select이므로 contains 사용
      if (poe) {
        filters.push({
          property: POE_PROP,
          multi_select: { contains: poe }
        });
      }

      if (filters.length > 0) {
        body.filter = { and: filters };
      }

      const pages = await queryAllDatabases(dbIds, body);
      const set = new Set();

      for (const p of pages) {
        const props = p.properties || {};
        // 2차 검증
        const cName  = getSelectName(props[COMPANY_PROP]);
        const pNames = getMultiSelectNames(props[POE_PROP]);

        if (company && !isCompanyMatch(cName, company)) continue;
        if (poe && !isPoeMatch(pNames, poe)) continue;

        const cTypes = getMultiSelectNames(props[CARGO_PROP]);
        cTypes.forEach(t => set.add(t));
      }

      return res.json({ types: [...set].sort() });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });


  /**
   * 4. [메인] 비용 조회 (최종 계산)
   * GET /api/costs/:country
   */
  app.get('/api/costs/:country', async (req, res) => {
    try {
      const country = (req.params.country || '').trim();
      if (!country) return res.status(400).json({ ok:false, error:'country is required' });
  
      const mode = (req.query.mode || '').trim();
      const region  = (req.query.region  || '').trim();
      const company = (req.query.company || '').trim();
      const poe     = (req.query.poe     || '').trim();
  
      const typeRaw = (req.query.type    || '20FT').trim().toUpperCase();
      const type    = (typeRaw === 'CONSOLE' ? 'CONSOLE' : typeRaw === '40HC' ? '40HC' : '20FT');
      const cbm = req.query.cbm != null ? Number(req.query.cbm) : NaN;
  
      const rolesParam = (req.query.roles || '').trim();
      const roles = rolesParam ? rolesParam.split(',').map(s => s.trim()).filter(Boolean) : [];
  
      const dbIds = getCountryDbIds(country);
      if (!dbIds.length) {
        return res.json({ ok: true, country, type, rows: [], numberFormats: {}, currency: 'USD' });
      }
  
      // --- [핵심 최적화] Notion Query 필터 구성 ---
      const body = {
        page_size: 100,
        sorts: [{ property: ORDER_PROP, direction: 'ascending' }],
      };
  
      // 필터 조건들을 담을 배열
      const filters = [];
  
      // 1. 지역 필터 (선택된 지역 OR 지역값이 비어있는 공통 항목)
      if (region) {
        filters.push({
          or: [
            { property: REGION_PROP, multi_select: { contains: region } },
            { property: REGION_PROP, multi_select: { is_empty: true } } // 공통 항목 포함
          ]
        });
      }
  
      // 2. 업체 필터 (선택된 업체 OR 업체값이 비어있는 공통 항목)
      // 주의: 업체가 비어있는 항목을 공통으로 쓸지 여부는 정책에 따름. 보통은 업체 지정 필수.
      // 여기서는 사용자가 선택한 업체만 가져오도록 함 (속도 향상)
      if (company) {
        filters.push({
          property: COMPANY_PROP,
          select: { equals: company }
        });
      }
      
      // 3. POE 필터 (선택된 POE가 포함된 것)
      if (poe) {
        filters.push({
            property: POE_PROP,
            multi_select: { contains: poe }
        });
      }
  
      // 필터 조합 (AND 조건)
      if (filters.length > 0) {
        body.filter = { and: filters };
      }
  
      // --- Notion 데이터 조회 (단 1회 수행) ---
      const pages = await queryAllDatabases(dbIds, body);
  
      if (mode === 'data') return res.json({ ok: true, country, rows: pages });
  
      const rows = [];
      for (const page of pages) {
        const props = page.properties || {};
  
        const regionNames = getMultiSelectNames(props[REGION_PROP]);
        const companyName = getSelectName(props[COMPANY_PROP]);
        const poeNames    = getMultiSelectNames(props[POE_PROP]);
        const cargoNames  = getMultiSelectNames(props[CARGO_PROP]);
        const basicType   = getSelectName(props[BASIC_PROP]) || '';
        const displayType = getSelectName(props[DISPLAY_TYPE_PROP]) || '';
        const order       = getNumberFromProp(props[ORDER_PROP]) ?? getOrderNumber(page);
  
        // --- [메모리상 2차 필터링] (API 필터의 한계 보완) ---
        // 1. 지역: 선택한 지역이거나, 아예 지역이 없는(공통) 경우만 통과
        const isCommonRegion = regionNames.length === 0;
        if (region && !regionNames.includes(region) && !isCommonRegion) continue;
  
        // 2. 업체: 일치해야 함
        if (!isCompanyMatch(companyName, company)) continue;
  
        // 3. POE: 일치해야 함
        if (!isPoeMatch(poeNames, poe)) continue;
  
        // 4. 화물타입: 일치해야 함
        if (!isCargoMatch(cargoNames, roles)) continue;
  
        // 금액 계산
        const amount = computeAmount(props, type, cbm, region);
        const item  = getTitle(props, ITEM_PROP) || getTitle(props, 'Name') || '';
        const extra = getRichTextHtml(props, EXTRA_PROP) || '';
  
        rows.push({
          id: page.id,
          item,
          region: regionNames.join(', '), // 디버깅용 표시
          company: companyName,
          poe: poeNames.join(', '),
          cargoTypes: cargoNames,
          basicType,
          displayType,
          order,
          [type]: amount ?? null,
          extra,
        });
      }
  
      rows.sort((a, b) => (Number(a.order)||0) - (Number(b.order)||0));
  
      return res.json({
        ok: true, country, type, rows, numberFormats: {}, currency: 'USD',
      });
  
    } catch (e) {
      console.error('GET /api/costs error:', e);
      res.status(500).json({ ok: false, error: 'costs failed' });
    }
  });
}

module.exports = registerCostsRoutes;
