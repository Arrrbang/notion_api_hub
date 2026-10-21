/**
 * DEST_RATE 도착지 조회 백엔드
 * - 대표 DB의 나라명, 타리프 DB ID, 위경도 DB ID를 읽습니다.
 * - 국가별 위경도 DB에서 지역명/LAT/LNG를 반환합니다.
 * - 지역 → 업체 → 화물타입 → POE → 컨테이너타입 순으로 타리프 목록을 조회합니다.
 * - 이전 단계 선택값 모두가 일치하는 행만 사용하며 빈 속성을 공통값으로 포함하지 않습니다.
 * - 목록 중복 제거 및 전체 페이지네이션을 처리합니다. POE는 PORT CODE 부분 일치로 항구명에 매핑하며 원래 태그도 보관합니다.
 * - CBM 1~68은 프론트에서 생성합니다. 비용 계산/금액 조회는 아직 구현하지 않습니다.
 */
const axios = require('axios');
const PORT_DB_ID = '36e0b10191ce804492fce82a1d2719c3';
const MASTER_DB_ID = '4000b10191ce801c8ed9e2df011bf664';
const rich = p => (p?.rich_text || []).map(t => t.plain_text ?? t.text?.content ?? '').join('').trim();
const title = p => (p?.title || []).map(t => t.plain_text ?? t.text?.content ?? '').join('').trim();
function dbId(value) {
  const s = String(value || '').trim();
  if (/^[0-9a-f]{32}$/i.test(s) || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s)) return s.replace(/-/g, '');
  return null;
}
function coordinate(value, limit) {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}
module.exports = function registerDestRateRoutes(app) {
  function headers() {
    const token = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
    if (!token) throw new Error('Notion token missing');
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' };
  }
  async function queryAll(id, body = {}) {
    const pages = []; let cursor;
    do {
      const r = await axios.post(`https://api.notion.com/v1/databases/${id}/query`, {
        ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {})
      }, { headers: headers(), timeout: 20000 });
      pages.push(...(r.data.results || []));
      cursor = r.data.has_more ? r.data.next_cursor : null;
    } while (cursor);
    return pages;
  }
  async function countries() {
    return (await queryAll(MASTER_DB_ID)).map(p => ({
      id: p.id, name: title(p.properties?.['나라명']),
      tariffDbId: dbId(rich(p.properties?.['타리프 DB ID'])),
      locationDbId: dbId(rich(p.properties?.['위경도 DB ID']))
    })).filter(c => c.name).sort((a,b) => a.name.localeCompare(b.name, 'ko'));
  }
  function fail(res, error, message) {
    console.error('[DEST_RATE]', error.response?.status || error.code || error.message);
    return res.status(500).json({ ok: false, error: message });
  }
  app.get('/api/dest-rate/countries', async (req,res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, countries: await countries() });
    } catch (e) { fail(res,e,'국가 목록을 불러오지 못했습니다. 대표 DB 접근 권한과 속성을 확인해 주세요.'); }
  });
  app.get('/api/dest-rate/countries/:countryId/regions', async (req,res) => {
    try {
      res.set('Cache-Control', 'no-store');
      if (!dbId(req.params.countryId)) return res.status(400).json({ ok: false, error: '국가 ID가 올바르지 않습니다.' });
      // 클라이언트가 전달한 DB ID를 직접 조회하지 않고 대표 DB에서 연결을 확인합니다.
      const country = (await countries()).find(c => dbId(c.id) === dbId(req.params.countryId));
      if (!country) return res.status(404).json({ ok: false, error: '대표 DB에 등록되지 않은 국가입니다.' });
      if (!country.locationDbId) return res.status(422).json({ ok: false, error: '이 국가의 위경도 DB ID가 비어 있거나 올바르지 않습니다.' });
      const regions = (await queryAll(country.locationDbId)).map(p => {
        const name = title(p.properties?.['지역명']);
        const lat = coordinate(rich(p.properties?.LAT),90);
        const lng = coordinate(rich(p.properties?.LNG),180);
        return { id: p.id, name, lat, lng, hasCoordinates: lat !== null && lng !== null };
      }).filter(r => r.name).sort((a,b) => a.name.localeCompare(b.name,'ko'));
      res.json({ ok: true, country, regions, invalidCoordinateCount: regions.filter(r => !r.hasCoordinates).length });
    } catch (e) { fail(res,e,'지역 목록을 불러오지 못했습니다. 위경도 DB 접근 권한과 지역명·LAT·LNG 속성을 확인해 주세요.'); }
  });
  app.get('/api/dest-rate/countries/:countryId/tariff-options', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const stages = {
        companies: { required: ['region'], property: '업체', kind: 'select' },
        'cargo-types': { required: ['region', 'company'], property: '화물타입', kind: 'multi_select' },
        poes: { required: ['region', 'company', 'cargo'], property: 'POE', kind: 'multi_select' },
        'container-types': { required: ['region', 'company', 'cargo', 'portId'], property: '컨테이너 타입', kind: 'multi_select' }
      };
      const stage = stages[req.query.stage];
      if (!stage || !dbId(req.params.countryId)) return res.status(400).json({ ok: false, error: '조회 단계 또는 국가 ID가 올바르지 않습니다.' });
      const values = {};
      for (const key of stage.required) {
        if (typeof req.query[key] !== 'string' || !req.query[key].trim()) return res.status(400).json({ ok: false, error: `${key} 선택값이 필요합니다.` });
        values[key] = req.query[key].trim();
      }
      const country = (await countries()).find(c => dbId(c.id) === dbId(req.params.countryId));
      if (!country) return res.status(404).json({ ok: false, error: '대표 DB에 등록되지 않은 국가입니다.' });
      if (!country.tariffDbId) return res.status(422).json({ ok: false, error: '타리프 DB ID가 비어 있거나 올바르지 않습니다.' });
      const fields = { region: ['지역', 'multi_select'], company: ['업체', 'select'], cargo: ['화물타입', 'multi_select'], poe: ['POE', 'multi_select'] };
      let selectedPortCode = null;
      if (req.query.stage === 'container-types') {
        const port = (await queryAll(PORT_DB_ID)).find(p => dbId(p.id) === dbId(values.portId));
        if (!port) return res.status(400).json({ ok: false, error: '선택한 도착항구를 찾을 수 없습니다.' });
        selectedPortCode = rich(port.properties?.['PORT CODE']);
      }
      const filters = stage.required.filter(key => key !== 'portId').map(key => {
        const [property, kind] = fields[key];
        return { property, [kind]: { [kind === 'select' ? 'equals' : 'contains']: values[key] } };
      });
      const pages = await queryAll(country.tariffDbId, { filter: { and: filters } });
      const names = new Set();
      for (const page of pages) {
        const props = page.properties || {};
        // API 응답에서도 정확한 태그/업체 일치를 확인합니다.
        if (!stage.required.every(key => {
          if (key === 'portId') return (props.POE?.multi_select || []).some(item => item.name && selectedPortCode.includes(item.name));
          const [property, kind] = fields[key];
          return kind === 'select' ? props[property]?.select?.name === values[key]
            : (props[property]?.multi_select || []).some(item => item.name === values[key]);
        })) continue;
        if (stage.kind === 'select') {
          const name = props[stage.property]?.select?.name;
          if (name) names.add(name);
        } else {
          for (const item of props[stage.property]?.multi_select || []) if (item.name) names.add(item.name);
        }
      }
      let options;
      if (req.query.stage === 'poes') {
        // 문자열 그대로 부분 일치. (BUS), (INC), (VIA LA) 등은 제거하지 않습니다.
        // USATL은 (BUS)USATL(VIA SAV)와 (BUS)USATL(VIA LA) 모두와 일치합니다.
        options = (await queryAll(PORT_DB_ID)).map(page => {
          const code = rich(page.properties?.['PORT CODE']);
          const name = title(page.properties?.['PORT NAME']);
          const matchedPoes = [...names].filter(poe => code.includes(poe));
          return { id: page.id, name, portCode: code, matchedPoes };
        }).filter(item => item.name && item.matchedPoes.length)
          .sort((a,b) => a.name.localeCompare(b.name,'ko'));
      } else {
        options = [...names].sort((a,b) => a.localeCompare(b,'ko')).map(name => ({ id: name, name }));
      }
      res.json({ ok: true, stage: req.query.stage, options });
    } catch(e) { fail(res,e,'타리프 선택 목록을 불러오지 못했습니다. DB 권한과 속성을 확인해 주세요.'); }
  });

};
