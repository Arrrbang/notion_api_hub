// backend/costs.js
// 1번 표(기본표)용 /api/costs/:country 라우트

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
// 필터 로직 (지역/업체/POE/화물타입/기본)
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
    // 화물타입이 비어 있으면 "모든 타입"으로 볼지 말지는 취향인데,
    // 여기선 일단 포함(true)로 둠
    return true;
  }
  return cargoNames.some(c => roles.includes(c));
}

// CONSOLE 계산: MIN COST + ( (CBM - MIN CBM) * PER COST )
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

// CONSOLE 계산: MIN COST + ( (CBM - MIN CBM) * PER COST )
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

// 🔽 새로 추가: Notion "계산식" 속성에서 수식 텍스트 읽기
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

// 🔽 새로 추가: "50000 + (CBM-5)*10000" 같은 식을 평가
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
    // (이 서버는 내부에서만 쓰고, 위에서 문자 필터링 했기 때문에 리스크는 낮음)
    const fn = new Function('"use strict"; return (' + expr + ');');
    const val = fn();
    return Number.isFinite(val) ? val : undefined;
  } catch (e) {
    return undefined;
  }
}

// ------------------------------------------------------------
// CBM 범위 매칭 공식 처리 (1≤CBM≤10 = 200)
// ------------------------------------------------------------
function evalRangeFormula(code, cbm) {
  if (!code) return undefined;

  const lines = code.split(/\n+/).map(s => s.trim()).filter(Boolean);

  for (const line of lines) {
    //
    // 패턴 1: "1 ≤ CBM ≤ 10 = 200"
    //
    let m = line.match(/^(\d+)\s*[<≤]\s*CBM\s*[<≤]\s*(\d+)\s*=\s*(\d+)/i);
    if (m) {
      const low = Number(m[1]);
      const high = Number(m[2]);
      const val = Number(m[3]);
      if (cbm >= low && cbm <= high) return val;
      continue;
    }

    //
    // 패턴 2: "CBM > 20 = 400"
    //
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

    //
    // 패턴 3: "0 < CBM < 11 = 200"
    //
    m = line.match(/^(\d+)\s*<\s*CBM\s*<\s*(\d+)\s*=\s*(\d+)/i);
    if (m) {
      const low = Number(m[1]);
      const high = Number(m[2]);
      const val  = Number(m[3]);
      if (cbm > low && cbm < high) return val;
      continue;
    }

    //
    // 패턴 4: "IF CBM < 11 THEN 200"
    //
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

    //
    // 패턴 5: ELSE 300
    //
    m = line.match(/^ELSE\s+(\d+)/i);
    if (m) return Number(m[1]);
  }

  return undefined;
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
   *  - cbm      : 숫자 (CONSOLE 계산에 사용)
   *  - mode=data: 원본 Notion rows 그대로 반환 (cargo-types fallback 용)
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

      // mode=data 인 경우: 원본 그대로 돌려주기 (cargo-types fallback 용)
      if (mode === 'data') {
        return res.json({
          ok: true,
          country,
          rows: pages,
        });
      }

      // 기본표(1번 표)용 rows 가공
      const rows = [];

      for (const page of pages) {
        const props = page.properties || {};

        const regionNames = getMultiSelectNames(props[REGION_PROP]);
        const companyName = getSelectName(props[COMPANY_PROP]);
        const poeNames    = getMultiSelectNames(props[POE_PROP]);
        const cargoNames  = getMultiSelectNames(props[CARGO_PROP]);
        const basicType   = getSelectName(props[BASIC_PROP]) || '';

        // 1) "기본/추가" 선별별
        let rowsBasic = [];
        let rowsExtra = [];
        
        for (const page of pages) {
          const props = page.properties || {};
        
          const basicType = getSelectName(props[BASIC_PROP]) || '';
        
          // 금액 계산 로직 동일
          const amount = computeAmount(props, type, cbm); // 네가 이미 쓰고 있는 금액 계산 함수
        
          const rowObj = {
            id: page.id,
            item: getTitle(props, ITEM_PROP),
            extra: getRichText(props, EXTRA_PROP),
            region: regionNames.join(','),
            company: companyName,
            poe: poeNames.join(','),
            cargo: cargoNames.join(','),
            basicType,
            order: getNumberFromProp(props[ORDER_PROP]),
            [type]: amount,
          };
        
          if (basicType === '기본') rowsBasic.push(rowObj);
          else if (basicType === '추가') rowsExtra.push(rowObj);
        }


        // 2) 지역/업체/POE/화물타입 필터
        if (!isRegionMatch(regionNames, region))    continue;
        if (!isCompanyMatch(companyName, company))  continue;
        if (!isPoeMatch(poeNames, poe))            continue;
        if (!isCargoMatch(cargoNames, roles))      continue;

        // 3) 금액 계산 (타입과 상관 없이 공통 규칙)
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

        // ────────────────────────────────
        // 3-1) 타입별로 우선순위 적용
        // ────────────────────────────────
        if (type === '20FT') {
          if (Number.isFinite(val20)) {
            amount = val20;              // 20FT 값 최우선
          } else if (Number.isFinite(consoleAmt)) {
            amount = consoleAmt;         // 없으면 CONSOLE 공식
          }
        } else if (type === '40HC') {
          if (Number.isFinite(val40)) {
            amount = val40;              // 40HC 값 최우선
          } else if (Number.isFinite(consoleAmt)) {
            amount = consoleAmt;
          }
        } else {
          // type === 'CONSOLE'
          if (Number.isFinite(consoleAmt)) {
            amount = consoleAmt;         // CONSOLE 공식 우선
          }
        }

        // ────────────────────────────────
        // 3-2) 기본 요소(20FT/40HC/CONSOLE)가 전부 비어 있으면 → 계산식 사용
        //     (컨테이너 타입 드롭다운과 무관하게 동일 규칙)
        // ────────────────────────────────
        if (!hasBaseCost) {
          const code = getFormulaText(props, FORMULA_PROP);

          // 1순위: 범위식 (1 ≤ CBM ≤ 10 = 150 같은 패턴)
          let v = evalRangeFormula(code, cbm);
          if (!Number.isFinite(v)) {
            // 2순위: 일반 수학식 (50000 + (CBM-5)*10000)
            v = evalFormula(code, { cbm });
          }
          if (Number.isFinite(v)) {
            amount = v;
          }
        }




        // 4) 항목/비고 텍스트
        const item  = getTitle(props, ITEM_PROP) || getTitle(props, 'Name') || '';
        const extra = getRichText(props, EXTRA_PROP) || '';

        rows.push({
          id: page.id,
          item,
          region: regionNames.join(', '),
          company: companyName,
          poe: poeNames.join(', '),
          cargoTypes: cargoNames,
          basicType,
          [type]: amount ?? null,
          extra,
        });
        rows.sort((a, b) => {
          const oa = Number(a.order) || 0;
          const ob = Number(b.order) || 0;
          return oa - ob;
        });
        
        // 최종 응답
        return res.status(200).json({
          ok: true,
          ...
          rows,
        });
      }

      res.json({
        ok: true,
        country,
        type,
        rows,
        // 통화 포맷은 나중에 필요하면 확장 (지금은 심플하게)
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
