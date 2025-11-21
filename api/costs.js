// backend/costs.js
// 1번 표(기본/추가 통합 데이터)용 /api/costs/:country 라우트

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ────────────────────────────────
// 환경변수 & 노션 공통
// ────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// 속성명(노션에서 실제 쓰는 이름이 다르면 여기만 바꿔주면 됨)
const REGION_PROP     = process.env.REGION_PROP      || '지역';       // multi_select
const COMPANY_PROP    = process.env.COMPANY_PROP     || '업체';       // select
const POE_PROP        = process.env.POE_PROP         || 'POE';        // multi_select
const CARGO_PROP      = process.env.CARGO_PROP       || '화물타입';   // multi_select
const BASIC_PROP      = process.env.BASIC_PROP       || '기본/추가';  // select ("기본","추가" 등)
const ITEM_PROP       = process.env.ITEM_PROP        || '항목';       // title / rich_text
const EXTRA_PROP      = process.env.EXTRA_PROP       || '참고사항';   // rich_text(없으면 "비고"로 바꿔도 됨)
const FORMULA_PROP    = process.env.FORMULA_PROP     || '계산식';     // 수식 텍스트(50000 + (CBM-5)*10000)
const DISPLAY_TYPE_PROP = process.env.DISPLAY_TYPE_PROP || '표시타입'; // select ("테이블", "숨김" 등)


// CONSOLE 계산에 사용하는 속성
const MIN_COST_PROP   = process.env.MIN_COST_PROP    || 'MIN COST';
const MIN_CBM_PROP    = process.env.MIN_CBM_PROP     || 'MIN CBM';
const PER_COST_PROP   = process.env.PER_COST_PROP    || 'PER CBM';

// 순서 정렬용
const ORDER_PROP      = process.env.ORDER_PROP       || '순서';

// db-map.json 위치(지금 destination.js와 동일한 위치 기준)
function loadDbMap() {
  const full = path.join(process.cwd(), 'config', 'db-map.json');
  const raw  = fs.readFileSync(full, 'utf8');
  return JSON.parse(raw);
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

function getTitle(props, key) {
  const col = props?.[key];
  if (!col) return '';
  if (col.type === 'title') {
    return getTextFromRich(col.title);
  }
  if (col.type === 'rich_text') {
    return getTextFromRich(col.rich_text);
  }
  return '';
}

function getRichText(props, key) {
  const col = props?.[key];
  if (!col) return '';
  if (col.type === 'rich_text') {
    return getTextFromRich(col.rich_text);
  }
  if (col.type === 'title') {
    return getTextFromRich(col.title);
  }
  return '';
}

function getSelectName(prop) {
  if (!prop || prop.type !== 'select') return '';
  return prop.select?.name || '';
}

function getMultiSelectNames(prop) {
  if (!prop || prop.type !== 'multi_select') return [];
  return (prop.multi_select || [])
    .map(o => o?.name)
    .filter(Boolean);
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

// 페이지네이션 전체 읽기 (단일 DB)
async function queryAllPages(dbId, body) {
  let all = [];
  let hasMore = true;
  let cursor = undefined;

  while (hasMore) {
    const payload = { ...body };
    if (cursor) payload.start_cursor = cursor;

    const resp = await axios.post(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      payload,
      { headers: notionHeaders() }
    );

    const data = resp.data;
    all.push(...(data.results || []));
    hasMore = data.has_more;
    cursor  = data.next_cursor;
  }
  return all;
}

// 여러 DB 한 번에 읽기
async function queryAllDatabases(dbIds, body) {
  const out = [];
  for (const id of dbIds) {
    const pages = await queryAllPages(id, body);
    out.push(...pages);
  }
  return out;
}

// ────────────────────────────────
// 필터 로직 (지역/업체/POE/화물타입)
// ────────────────────────────────
function isRegionMatch(regionNames, selectedRegion) {
  // 선택 안 했으면 region 조건 없음
  if (!selectedRegion) return true;
  // 노션에 지역 값이 비어 있으면 "모든 지역에 공통"처럼 취급 → 포함
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
  if (!cargoNames.length) {
    // 화물타입이 비어 있으면 "모든 타입"으로 취급
    return true;
  }
  return cargoNames.some(c => roles.includes(c));
}

// ────────────────────────────────
// 금액 계산 관련
// ────────────────────────────────

// CONSOLE 계산: MIN COST + ((CBM - MIN CBM) * PER COST)
function calcConsoleAmount(props, cbm) {
  const minCost = getNumberFromProp(props[MIN_COST_PROP]);
  const minCbm  = getNumberFromProp(props[MIN_CBM_PROP]);
  const perCost = getNumberFromProp(props[PER_COST_PROP]);

  if (!Number.isFinite(cbm))           return undefined;
  if (!Number.isFinite(minCost))       return undefined;
  if (!Number.isFinite(minCbm))        return undefined;
  if (!Number.isFinite(perCost))       return undefined;

  if (cbm <= minCbm) return minCost;
  return minCost + (cbm - minCbm) * perCost;
}

// Notion "계산식" 속성에서 수식 텍스트 읽기
function getFormulaText(props, key) {
  const col = props?.[key];
  if (!col) return '';

  if (col.type === 'rich_text') {
    return getTextFromRich(col.rich_text);
  }
  if (col.type === 'title') {
    return getTextFromRich(col.title);
  }
  // 다른 타입이면 일단 문자열로 시도
  return String(col?.plain_text || '');
}

// "50000 + (CBM-5)*10000" 같은 단순 수학식 평가
function evalFormula(code, context) {
  if (!code) return undefined;
  let expr = String(code).trim();
  if (!expr) return undefined;

  // 허용 문자: 숫자, 공백, + - * / . ( ) 그리고 CBM/cbm
  const safe = /^[0-9+\-*/().\sCBMcbm]+$/;
  if (!safe.test(expr)) {
    return undefined; // 허용 안 하는 문자가 있으면 그냥 무시
  }

  // CBM 변수를 실제 숫자로 치환
  const cbmVal = Number(context?.cbm ?? 0);
  expr = expr.replace(/CBM/gi, String(cbmVal));

  try {
    // 최소한으로 감싼 eval
    const fn = new Function('"use strict"; return (' + expr + ');');
    const val = fn();
    return Number.isFinite(val) ? val : undefined;
  } catch (e) {
    return undefined;
  }
}

// CBM 범위 매칭 공식 처리 (예: "1 ≤ CBM ≤ 10 = 200")
function evalRangeFormula(code, cbm) {
  if (!code) return undefined;

  const lines = code.split(/\n+/).map(s => s.trim()).filter(Boolean);

  for (const line of lines) {
    // 패턴 1: "1 ≤ CBM ≤ 10 = 200"
    let m = line.match(/^(\d+)\s*[<≤]\s*CBM\s*[<≤]\s*(\d+)\s*=\s*(\d+)/i);
    if (m) {
      const low  = Number(m[1]);
      const high = Number(m[2]);
      const val  = Number(m[3]);
      if (cbm >= low && cbm <= high) return val;
      continue;
    }

    // 패턴 2: "CBM > 20 = 400"
    m = line.match(/^CBM\s*([<>]=?)\s*(\d+)\s*=\s*(\d+)/i);
    if (m) {
      const op  = m[1];
      const num = Number(m[2]);
      const val = Number(m[3]);

      if (
        (op === '<'  && cbm <  num) ||
        (op === '>'  && cbm >  num) ||
        (op === '<=' && cbm <= num) ||
        (op === '>=' && cbm >= num)
      ) return val;

      continue;
    }

    // 패턴 3: "0 < CBM < 11 = 200"
    m = line.match(/^(\d+)\s*<\s*CBM\s*<\s*(\d+)\s*=\s*(\d+)/i);
    if (m) {
      const low  = Number(m[1]);
      const high = Number(m[2]);
      const val  = Number(m[3]);
      if (cbm > low && cbm < high) return val;
      continue;
    }

    // 패턴 4: "IF CBM < 11 THEN 200"
    m = line.match(/^IF\s+CBM\s*([<>]=?)\s*(\d+)\s+THEN\s+(\d+)/i);
    if (m) {
      const op  = m[1];
      const num = Number(m[2]);
      const val = Number(m[3]);

      if (
        (op === '<'  && cbm <  num) ||
        (op === '>'  && cbm >  num) ||
        (op === '<=' && cbm <= num) ||
        (op === '>=' && cbm >= num)
      ) return val;

      continue;
    }

    // 패턴 5: "ELSE 300"
    m = line.match(/^ELSE\s+(\d+)/i);
    if (m) return Number(m[1]);
  }

  return undefined;
}

// REGION / DEFAULT / IF(...) 지원용 계산식 전처리
function applyRegionFormula(code, selectedRegion, baseAmount, cbm) {
  if (!code) return code;
  let expr = String(code);

  const regionVal  = (selectedRegion || '').trim();
  const defaultVal = Number.isFinite(baseAmount) ? baseAmount : 0;

  // DEFAULT → 숫자 치환
  expr = expr.replace(/\bDEFAULT\b/gi, String(defaultVal));

  // IF(REGION="...", A, B) 처리 (간단한 한 단계 IF 기준)
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

// 공통 금액 계산 로직
function computeAmount(props, type, cbm, selectedRegion) {
  let amount;

  // 1) 20FT / 40HC 직접 값
  const val20 = getNumberFromProp(props['20FT']);
  const val40 = getNumberFromProp(props['40HC']);

  // 2) CONSOLE 공식
  const consoleAmt = calcConsoleAmount(props, cbm);

  // 3) "기본 금액 요소가 하나라도 있는지" 플래그
  const hasBaseCost =
    Number.isFinite(val20) ||
    Number.isFinite(val40) ||
    Number.isFinite(consoleAmt);

  // 3-1) 타입별 우선순위 (기본 금액 계산)
  if (type === '20FT') {
    if (Number.isFinite(val20)) {
      amount = val20;
    } else if (Number.isFinite(consoleAmt)) {
      amount = consoleAmt;
    }
  } else if (type === '40HC') {
    if (Number.isFinite(val40)) {
      amount = val40;
    } else if (Number.isFinite(consoleAmt)) {
      amount = consoleAmt;
    }
  } else {
    // type === 'CONSOLE'
    if (Number.isFinite(consoleAmt)) {
      amount = consoleAmt;
    }
  }

  const baseAmount = amount;
  const rawFormula = getFormulaText(props, FORMULA_PROP);

  // 3-2) 계산식 사용 여부:
  //  - 기본 금액이 없는 경우 (이전과 동일)
  //  - 또는 계산식 안에 REGION / DEFAULT 가 들어있는 경우(지역/기본금액 조건식)
  const shouldUseFormula =
    rawFormula &&
    (!hasBaseCost || /REGION\b|DEFAULT\b/i.test(rawFormula));

  if (shouldUseFormula) {
    const regionStr = selectedRegion || '';
    const code = applyRegionFormula(rawFormula, regionStr, baseAmount, cbm);

    // 1순위: 범위식
    let v = evalRangeFormula(code, cbm);
    if (!Number.isFinite(v)) {
      // 2순위: 일반 수학식
      v = evalFormula(code, { cbm });
    }
    if (Number.isFinite(v)) {
      amount = v;
    }
  }

  return amount;
}


// ────────────────────────────────
// 라우트 등록
// ────────────────────────────────
function registerCostsRoutes(app) {
  /**
   * GET /api/costs/:country
   *
   * 쿼리:
   *  - region   : 지역(선택)
   *  - company  : 업체(단일선택)
   *  - poe      : POE(다중선택 중 하나)
   *  - roles    : 화물타입(대문자로, 콤마구분) 예: roles=DIPLOMAT,NON-DIPLO
   *  - type     : "20FT" | "40HC" | "CONSOLE"
   *  - cbm      : 숫자 (CONSOLE/계산식에 사용)
   *  - mode=data: 원본 Notion rows 그대로 반환
   */
  app.get('/api/costs/:country', async (req, res) => {
    try {
      const country = (req.params.country || '').trim();
      if (!country) {
        return res.status(400).json({ ok:false, error:'country is required' });
      }

      const mode = (req.query.mode || '').trim();

      const region  = (req.query.region  || '').trim();
      const company = (req.query.company || '').trim();
      const poe     = (req.query.poe     || '').trim();

      const typeRaw = (req.query.type    || '20FT').trim().toUpperCase();
      const type    = (typeRaw === 'CONSOLE' ? 'CONSOLE'
                      : typeRaw === '40HC'   ? '40HC'
                      : '20FT');

      const cbm = req.query.cbm != null ? Number(req.query.cbm) : NaN;

      const rolesParam = (req.query.roles || '').trim();
      const roles = rolesParam
        ? rolesParam.split(',').map(s => s.trim()).filter(Boolean)
        : [];

      const dbIds = getCountryDbIds(country);
      if (!dbIds.length) {
        return res.json({
          ok: true,
          country,
          type,
          rows: [],
          numberFormats: {},
          currency: 'USD',
        });
      }

      if (!NOTION_TOKEN) {
        return res.status(500).json({
          ok: false,
          error: 'NOTION_API_KEY / NOTION_TOKEN is missing',
        });
      }

      // 공통 body (정렬만)
      const body = {
        page_size: 100,
        sorts: [{ property: ORDER_PROP, direction: 'ascending' }],
      };

      // Notion에서 전체 페이지 읽기
      const pages = await queryAllDatabases(dbIds, body);

      // mode=data 인 경우: 원본 그대로 돌려주기
      if (mode === 'data') {
        return res.json({
          ok: true,
          country,
          rows: pages,
        });
      }

      // 최종 rows (기본 + 추가 모두 포함, basicType으로 구분)
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

        // 지역/업체/POE/화물타입 필터
        if (!isRegionMatch(regionNames, region))    continue;
        if (!isCompanyMatch(companyName, company))  continue;
        if (!isPoeMatch(poeNames, poe))            continue;
        if (!isCargoMatch(cargoNames, roles))      continue;

        // 금액 계산 (컨테이너 타입과 무관한 공통 규칙)
        const amount = computeAmount(props, type, cbm, region);

        // 항목/비고 텍스트
        const item  = getTitle(props, ITEM_PROP) || getTitle(props, 'Name') || '';
        const extra = getRichText(props, EXTRA_PROP) || '';

        rows.push({
          id: page.id,
          item,
          region: regionNames.join(', '),
          company: companyName,
          poe: poeNames.join(', '),
          cargoTypes: cargoNames,
          basicType,         // "기본" / "추가"
          displayType,
          order,
          [type]: amount ?? null,
          extra,
        });
      }

      // "순서" 기준 정렬
      rows.sort((a, b) => {
        const oa = Number(a.order) || 0;
        const ob = Number(b.order) || 0;
        return oa - ob;
      });

      // 최종 응답
      return res.json({
        ok: true,
        country,
        type,
        rows,
        numberFormats: {},
        currency: 'USD',
      });
    } catch (e) {
      console.error('GET /api/costs error:', e.response?.data || e);
      res.status(500).json({
        ok: false,
        error: 'costs failed',
        details: e.response?.data || e.message || String(e),
      });
    }
  });
}

module.exports = registerCostsRoutes;
