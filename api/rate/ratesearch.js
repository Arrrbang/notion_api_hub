/**
 * 국가별 타리프 DB의 지역 다중선택과 POE를 묶는 API를 제공합니다.
 * 기존 API 호환 유지: 배송지역을 쉼표로 분리하고 같은 지역 행의 POE를 합칩니다.
 * POE는 multi_select/select/rich_text/title 속성을 지원하며 (BUS)/(INC)/(VIA ...)를 보존합니다.
 * 운임 금액 조회는 기존 /api/mail/booking/rates를 그대로 사용합니다.
 */
const axios = require("axios");

const DELIVERY_REGION_DB_ID = "3720b10191ce80e291e3ca782bb6f0a1";
const PORT_CODE_DB_ID = "36e0b10191ce804492fce82a1d2719c3";
const text = prop => (prop?.rich_text || []).map(item => item.plain_text ?? item.text?.content ?? "").join("");
const title = prop => (prop?.title || []).map(item => item.plain_text ?? item.text?.content ?? "").join("");
// 접두어를 제거하지 않습니다. (BUS)USLAX와 (INC)USLAX는 서로 다른 조회 키입니다.
const splitCodes = value => [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];

function poeCodes(prop) {
  if (!prop) return [];
  const values = prop.multi_select ? prop.multi_select.map(item => item.name)
    : prop.select ? [prop.select.name]
    : prop.rich_text ? [text(prop)] : prop.title ? [title(prop)] : [];
  return [...new Set(values.flatMap(value => splitCodes(value || "")))];
}

// PORT CODE의 개별 코드와 쉼표로 묶인 그래프 속성명을 비교합니다.
// 접두어/VIA는 유지하고 쉼표 앞뒤 공백만 제거합니다. 부분 일치는 사용하지 않습니다.
function historyValue(properties, code) {
  const target = String(code).trim();
  const numeric = Object.entries(properties || {}).filter(([, prop]) => prop?.type === 'number' || Object.prototype.hasOwnProperty.call(prop || {}, 'number'));
  const exact = numeric.filter(([name]) => name.trim() === target);
  const matches = exact.length ? exact : numeric.filter(([name]) => splitCodes(name).includes(target));
  if (matches.length > 1) throw new Error(`운임 변동 DB의 코드 속성이 중복되어 있습니다: ${target}`);
  const value = matches[0]?.[1]?.number;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function queryAll(databaseId, body = {}) {
  const token = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
  if (!token) throw new Error("Notion API token is missing");
  const pages = [];
  let cursor;
  do {
    const response = await axios.post(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      ...body,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    }, {
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      }
    });
    pages.push(...(response.data.results || []));
    cursor = response.data.has_more ? response.data.next_cursor : null;
  } while (cursor);
  return pages;
}

module.exports = function registerRateSearchRoutes(app) {
  /** 운임 변동: 허용된 항구 ID를 PORT CODE로 변환하고, 두 DB의 숫자 속성명을 쉼표로 분리해 같은 코드가 포함된 속성을 읽습니다.
   * 기간 제목 오름차순(A→Z), 전체 페이지네이션, null(미등록)과 0(실제값)을 구분합니다.
   */
  app.get('/api/rate-search/history', async (req,res) => {
    try {
      res.set('Cache-Control','no-store');
      const normalize = value => String(value || '').replace(/-/g,'').toLowerCase();
      if (typeof req.query.portIds !== 'string') return res.status(400).json({ok:false,error:'항구 ID가 필요합니다.'});
      const ids = [...new Set(req.query.portIds.split(',').map(normalize))];
      if (!ids.length || ids.length > 100 || ids.some(id=>!/^[0-9a-f]{32}$/.test(id))) return res.status(400).json({ok:false,error:'항구 ID가 올바르지 않습니다. 최대 100개까지 조회할 수 있습니다.'});
      const ports = (await queryAll(PORT_CODE_DB_ID)).filter(page=>ids.includes(normalize(page.id)));
      if (ports.length !== ids.length) return res.status(404).json({ok:false,error:'등록되지 않은 항구입니다.'});
      const definitions = [{key:'dr20',name:'20DRY',id:'3790b10191ce8030932bfc233c74af8a'},{key:'hc40',name:'40HC',id:'3790b10191ce805ca871fc6cf2bc2dba'}];
      const containers = await Promise.all(definitions.map(async definition => {
        const rows = await queryAll(definition.id,{sorts:[{property:'기간',direction:'ascending'}]});
        return {key:definition.key,name:definition.name,series:ports.flatMap(port=>splitCodes(text(port.properties?.['PORT CODE'])).map(code=>({
          portId:port.id,name:title(port.properties?.['PORT NAME']),code,
          points:rows.map(row=>{
            const value=historyValue(row.properties, code);
            return {id:row.id,period:title(row.properties?.['기간']),value:typeof value==='number' && Number.isFinite(value)?value:null};
          })
        })))};
      }));
      res.json({ok:true,containers});
    } catch(error) {
      console.error('[rate-search/history]',error.response?.status || error.message);
      res.status(500).json({ok:false,error:'운임 변동을 불러오지 못했습니다. 두 DB의 접근 권한과 기간·PORT CODE 숫자 속성을 확인해 주세요.'});
    }
  });
  // 대표 DB에 등록된 타리프 DB만 조회합니다. 클라이언트가 DB ID를 직접 지정하지 않습니다.
  app.get('/api/rate-search/countries/:countryId/tariff-regions', async (req, res) => {
    const normalize = value => String(value || '').replace(/-/g, '').toLowerCase();
    try {
      res.set('Cache-Control', 'no-store');
      const id = normalize(req.params.countryId);
      if (!/^[0-9a-f]{32}$/.test(id)) return res.status(400).json({ok:false,error:'국가 ID가 올바르지 않습니다.'});
      const master = (await queryAll('4000b10191ce801c8ed9e2df011bf664')).find(page => normalize(page.id) === id);
      if (!master) return res.status(404).json({ok:false,error:'등록되지 않은 국가입니다.'});
      const tariffId = normalize(text(master.properties?.['타리프 DB ID']).trim());
      if (!/^[0-9a-f]{32}$/.test(tariffId)) return res.status(422).json({ok:false,error:'타리프 DB ID를 확인해 주세요.'});
      const regions = new Map();
      for (const page of await queryAll(tariffId)) {
        const poes = poeCodes(page.properties?.POE);
        for (const item of page.properties?.['지역']?.multi_select || []) {
          if (!item.name) continue;
          if (!regions.has(item.name)) regions.set(item.name, new Set());
          poes.forEach(poe => regions.get(item.name).add(poe));
        }
      }
      res.json({ok:true,options:[...regions].map(([name,poes])=>({value:name,name,poes:[...poes]})).sort((a,b)=>a.name.localeCompare(b.name,'ko'))});
    } catch(error) {
      console.error('[rate-search/tariff-regions]',error.response?.status || error.message);
      res.status(500).json({ok:false,error:'타리프 DB의 지역과 POE 목록을 불러오지 못했습니다.'});
    }
  });
  app.get("/api/rate-search/delivery-regions", async (req, res) => {
    try {
      const pages = await queryAll(DELIVERY_REGION_DB_ID);
      const regions = new Map();
      for (const page of pages) {
        for (const name of splitCodes(text(page.properties?.["배송지역"]))) {
          if (!regions.has(name)) regions.set(name, { ids: new Set(), codes: new Set() });
          const region = regions.get(name);
          region.ids.add(page.id);
          poeCodes(page.properties?.POE).forEach(code => region.codes.add(code));
        }
      }
      const options = [...regions].map(([name, region]) => ({
        value: name, name, label: name, sourcePageIds: [...region.ids], codes: [...region.codes]
      })).sort((a, b) => a.name.localeCompare(b.name, "ko"));
      res.json({ ok: true, options });
    } catch (error) {
      console.error("[rate-search/delivery-regions]", error.response?.status || error.code || error.message);
      res.status(500).json({ ok: false, error: "배송지역 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
    }
  });

  app.get("/api/rate-search/arrival-ports", async (req, res) => {
    try {
      const pages = await queryAll(PORT_CODE_DB_ID);
      const options = pages.map(page => {
        const name = title(page.properties?.["PORT NAME"]).trim();
        const codes = splitCodes(text(page.properties?.["PORT CODE"]));
        return { id: page.id, value: page.id, name, label: name, code: codes.join(","), codes };
      }).filter(item => item.name).sort((a, b) => a.name.localeCompare(b.name, "ko"));
      // PORT CODE가 없어도 PORT NAME이 있으면 목록에 표시합니다.
      res.json({ ok: true, options });
    } catch (error) {
      console.error("[rate-search/arrival-ports]", error.response?.status || error.code || error.message);
      res.status(500).json({ ok: false, error: "도착항구 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
    }
  });
};
