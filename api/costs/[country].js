import dbMap from "../../config/db-map.json" assert { type: "json" };
import allowedTypes from "../../config/allowed-types.json" assert { type: "json" };
import { withCORS, preflight } from "../../lib/cors.js";
import { queryDatabase } from "../../lib/notion.js";
import { extractTitle, valueFromColumn, pickNumber } from "../../lib/pick.js";

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  const { country } = req.query;
  const typeParam = (req.query.type || "").trim();
  const type = typeParam || allowedTypes[0]; // 기본값: 첫 번째 허용 타입(예: "20FT")

  if (!allowedTypes.includes(type)) {
    res.status(400).json({
      ok: false,
      error: `Invalid type. Use one of: ${allowedTypes.join(", ")}`
    });
    return;
  }

  const dbid = dbMap[country];
  if (!dbid) {
    res.status(404).json({ ok: false, error: `Unknown country: ${country}` });
    return;
  }

  try {
    // 전체 로우 조회 (필요시 정렬 추가 가능)
    const resp = await queryDatabase({ database_id: dbid, page_size: 100 });
    const results = resp.results || [];

    const values = {};
    const rows = [];

    for (const page of results) {
      const props = page.properties || {};
      const { text: itemName } = extractTitle(props);
      if (!itemName) continue;

      // 각 열을 모두 모아두면 프런트에서 재활용 가능
      const rowObj = { item: itemName };
      for (const key of allowedTypes) {
        rowObj[key] = pickNumber(valueFromColumn(props, key));
      }
      rows.push(rowObj);

      // 요청된 type의 값만 추출하여 상단 "values" 맵 구성
      values[itemName] = pickNumber(valueFromColumn(props, type));
    }

    withCORS(res);
    const cacheTtl = Number(process.env.CACHE_TTL_SECONDS || 600);
    res.setHeader("Cache-Control", `s-maxage=${cacheTtl}, stale-while-revalidate=86400`);

    res.status(200).json({
      ok: true,
      country,
      type,
      values,   // ← 프런트는 이 맵만 써도 충분: { "CDS": 얼마, "SHC": 얼마, "DRC": 얼마, ... }
      rows,     // ← (옵션) 테이블 전체를 함께 제공
      has_more: resp.has_more,
      next_cursor: resp.next_cursor || null,
      servedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
