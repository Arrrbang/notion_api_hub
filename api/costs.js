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

// CONSOLE 계산에 사용하는 속성
const MIN_COST_PROP   = process.env.MIN_COST_PROP    || 'MIN COST';
const MIN_CBM_PROP    = process.env.MIN_CBM_PROP     || 'MIN CBM';
const PER_COST_PROP   = process.env.PER_COST_PROP    || 'PER COST';

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

        // 1) "기본/추가" 중 "기본"만 1번 표에 사용
        if (basicType !== '기본') continue;

        // 2) 지역/업체/POE/화물타입 필터
        if (!isRegionMatch(regionNames, region))    continue;
        if (!isCompanyMatch(companyName, company))  continue;
        if (!isPoeMatch(poeNames, poe))            continue;
        if (!isCargoMatch(cargoNames, roles))      continue;

        // 3) 금액 계산
        let amount;

        if (type === 'CONSOLE') {
          // CONSOLE: MIN COST + ((CBM - MIN CBM) * PER COST)
          amount = calcConsoleAmount(props, cbm);
        } else {
          // 20FT / 40HC: 해당 컬럼 값 우선
          const direct = getNumberFromProp(props[type]);
          if (Number.isFinite(direct)) {
            amount = direct;
          } else {
            // 20FT/40HC 값이 없으면 CONSOLE 로직으로 계산
            amount = calcConsoleAmount(props, cbm);
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
