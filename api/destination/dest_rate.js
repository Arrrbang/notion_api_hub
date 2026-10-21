const axios = require('axios');
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
  async function queryAll(id) {
    const pages = []; let cursor;
    do {
      const r = await axios.post(`https://api.notion.com/v1/databases/${id}/query`, {
        page_size: 100, ...(cursor ? { start_cursor: cursor } : {})
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
};
