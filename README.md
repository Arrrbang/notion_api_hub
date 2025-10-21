# NOTION API HUB (Country Costs)

노션의 국가별 데이터베이스에서 `20FT / 40HC / MIN CBM / PER CBM / FIXED` 열 값을
"항목(CDS/SHC/DRC ...)" 기준으로 뽑아 JSON으로 제공하는 API.

## 준비
1) 노션 상위 페이지에 Integration 공유 → 하위에 국가별 DB 배치
2) 각 DB의 ID를 `config/db-map.json`에 매핑
3) Vercel 환경변수 `NOTION_TOKEN` 등록
4) (옵션) `CORS_ALLOW_ORIGINS`, `CACHE_TTL_SECONDS` 설정

## 엔드포인트
- Health: `/api/health`
- 디버그(열 확인): `/api/notion/list-columns?country=TEST국가`
- **코스트 조회(핵심)**: `/api/costs/{country}?type=20FT`

### 응답 형태(예)
```json
{
  "ok": true,
  "country": "TEST국가",
  "type": "20FT",
  "values": { "CDS": 120, "SHC": 45, "DRC": 380 },
  "rows": [{ "item":"CDS", "20FT":120, "40HC":null, "MIN CBM":null, "PER CBM":null, "FIXED":null }]
}
