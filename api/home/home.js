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
  "admin": "정창락",
};

function getDateString(date) {
  return date.toISOString().split('T')[0];
}

function formatNotionPage(page) {
  const props = page.properties;
  
  const clientName = props["고객명"]?.title?.[0]?.plain_text || "이름 없음";
  const country = props["국가"]?.select?.name || "";
  const assignees = props["업무담당"]?.people?.map(p => p.name).join(", ") || "배정 안됨";
  const deadline = props["서류마감"]?.date?.start || "";

  return {
    id: page.id,
    clientName,
    country,
    assignees,
    deadline
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
    const todayStr = getDateString(today);
    const nextWeekStr = getDateString(nextWeek);

    // ─────────────────────────────────────────────────────────────
    // Query 1: 급한 건 (날짜 필터 O)
    // ─────────────────────────────────────────────────────────────
    const urgentQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        filter: {
          and: [
            { property: "영업담당", select: { equals: salesRepName } },
            { property: "여권수취여부", select: { does_not_equal: "수취" } },
            // 날짜 제한은 여기에만 적용됨
            { property: "서류마감", date: { on_or_after: todayStr } },
            { property: "서류마감", date: { on_or_before: nextWeekStr } }
          ]
        }
      },
      { headers: notionHeaders() }
    );

    // ─────────────────────────────────────────────────────────────
    // Query 2: 보관 건 (보관유무 = Status)
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
        { headers: notionHeaders() }
      );

    // ─────────────────────────────────────────────────────────────
    // Query 3: 보험 요청 건 (보험가입 = Select)
    // [수정 완료] 다시 select로 변경, 날짜 필터 없음 확인
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
        { headers: notionHeaders() }
      );

    const [urgentRes, storageRes, insuranceRes] = await Promise.all([urgentQuery, storageQuery, insuranceQuery]);

    const urgentData = urgentRes.data.results.map(formatNotionPage);
    const storageData = storageRes.data.results.map(formatNotionPage);
    const insuranceData = insuranceRes.data.results.map(formatNotionPage);

    res.json({ 
      ok: true, 
      targetName: salesRepName,
      data: {
        urgent: urgentData,
        storage: storageData,
        insurance: insuranceData
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
  app.use("/api/home", router);
};
