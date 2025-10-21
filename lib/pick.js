export function pickNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

export function extractTitle(properties) {
  // 노션 테이블의 제목 속성(예: "항목")은 타입 "title" 1개가 존재
  const [k, v] = Object.entries(properties).find(([, val]) => val?.type === "title") || [];
  if (!k) return { key: null, text: null };
  const text = (v.title || []).map(t => t.plain_text || "").join("").trim();
  return { key: k, text: text || null };
}

export function valueFromColumn(properties, columnName) {
  const col = properties[columnName];
  if (!col) return null;
  switch (col.type) {
    case "number":
      return pickNumber(col.number);
    case "rich_text":
      return pickNumber((col.rich_text || []).map(t => t.plain_text || "").join("").trim());
    case "formula":
      return pickNumber(col.formula?.[col.formula?.type] ?? null);
    default:
      // 필요한 경우 확장(checkbox/url 등)
      return null;
  }
}
