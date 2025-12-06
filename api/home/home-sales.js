const express = require("express");
const axios = require("axios");
const router = express.Router();

// Notion 설정
const NOTION_DATABASE_ID = "2760b10191ce80799f5fe13cd365ddad";
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

const USER_MAPPING = {
  "crjung": "정창락",
  "sk": "이상권",
  "eric": "허용수",
  "oh": "오수일",
  "kbs": "김병수",
  "pjs": "박제선",
  "salea": "임상훈",
  "saleb": "이주봉",
  "salek": "김영규"
};

function formatNotionPage(page) {
  const props = page.properties;
  
  const clientName = props["고객명"]?.title?.[0]?.plain_text || "이름 없음";
  
  // 국가: 한글만 추출
  const countryRaw = props["국가"]?.select?.name || "";
  const country = countryRaw.match(/[가-힣]+/g)?.join(" ") || countryRaw;
  
  const assignees = props["업무담당"]?.people?.map(p => p.name).join(", ") || "배정 안됨";
  
  // 날짜 형식에서 시간 제거 (YYYY-MM-DD)
  const deadline = (props["서류마감"]?.date?.start || "").split("T")[0];
  const packingDate = (props["포장일"]?.date?.start || "").split("T")[0]; // [NEW] 포장일

  // [NEW] 추가 필드
  const poe = props["POE"]?.select?.name || props["POE"]?.rich_text?.[0]?.plain_text || ""; 
  const salesRep = props["영업담당"]?.select?.name || "";

  return {
    id: page.id,
    clientName,
    country,
    assignees,
    deadline,
    packingDate, // [NEW]
    poe,         // [NEW]
    salesRep     // [NEW]
  };
}

router.get("/", async (req, res) => {
  try {
    const { username } = req.query;
    const salesRepName = USER_MAPPING[username];

    if (!salesRepName) {
      return res.status(400).json({ ok: false, error: "매칭되는 영업담당자가 없습니다." });
    }

    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);
    const todayStr = today.toISOString().split('T')[0];
    const nextWeekStr = nextWeek.toISOString().split('T')[0];

    // Common Headers
    const headers = notionHeaders();

    // ─────────────────────────────────────────────────────────────
    // Query 1: 급한 건 (기존)
    // ─────────────────────────────────────────────────────────────
    const urgentQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        filter: {
          and: [
            { property: "영업담당", select: { equals: salesRepName } },
            { property: "여권수취여부", select: { does_not_equal: "수취" } },
            { property: "서류마감", date: { on_or_after: todayStr } },
            { property: "서류마감", date: { on_or_before: nextWeekStr } }
          ]
        }
      },
      { headers }
    );

    // ─────────────────────────────────────────────────────────────
    // Query 2: 보관 건 (기존)
    // ─────────────────────────────────────────────────────────────
    const storageQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        filter: {
          and: [
            { property: "영업담당", select: { equals: salesRepName } },
            { property: "보관유무", status: { equals: "보관" } } 
          ]
        }
      },
      { headers }
    );

    // ─────────────────────────────────────────────────────────────
    // Query 3: 보험 요청 건 (기존)
    // ─────────────────────────────────────────────────────────────
    const insuranceQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        filter: {
          and: [
            { property: "영업담당", select: { equals: salesRepName } },
            { property: "보험가입", select: { equals: "보험요청" } } 
          ]
        }
      },
      { headers }
    );

    // ─────────────────────────────────────────────────────────────
    // [NEW] Query 4: 콘솔 대기 건 (전체 공유, 정렬 적용)
    // 조건: "컨테이너/콘솔" == "콘솔대기"
    // 정렬: 1순위 POE(오름차순), 2순위 포장일(오름차순)
    // ─────────────────────────────────────────────────────────────
    const consoleQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        filter: {
          property: "컨테이너/콘솔",
          select: { equals: "콘솔대기" }
        },
        sorts: [
          { property: "POE", direction: "ascending" },
          { property: "포장일", direction: "ascending" }
        ]
      },
      { headers }
    );

    // 모든 쿼리 병렬 실행
    const [urgentRes, storageRes, insuranceRes, consoleRes] = await Promise.all([
      urgentQuery, 
      storageQuery, 
      insuranceQuery,
      consoleQuery
    ]);

    res.json({ 
      ok: true, 
      targetName: salesRepName,
      data: {
        urgent: urgentRes.data.results.map(formatNotionPage),
        storage: storageRes.data.results.map(formatNotionPage),
        insurance: insuranceRes.data.results.map(formatNotionPage),
        console: consoleRes.data.results.map(formatNotionPage) // [NEW]
      }
    });

  } catch (error) {
    console.error("Notion API Error:", error.response?.data || error.message);
    res.status(500).json({ 
      ok: false, 
      error: "서버 내부 오류가 발생했습니다.", 
      details: error.response?.data || error.message 
    });
  }
});

module.exports = (app) => {
  app.use("/api/home/home-sales", router);
};
