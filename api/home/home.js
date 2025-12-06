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

// [수정] 노션 데이터 포맷팅 함수 (국가 추가)
function formatNotionPage(page) {
  const props = page.properties;
  
  // 1. 고객명
  const clientName = props["고객명"]?.title?.[0]?.plain_text || "이름 없음";
  
  // 2. [추가] 국가 (선택 속성)
  const country = props["국가"]?.select?.name || "";

  // 3. 업무담당
  const assignees = props["업무담당"]?.people?.map(p => p.name).join(", ") || "배정 안됨";
  
  // 4. 서류마감
  const deadline = props["서류마감"]?.date?.start || "";

  return {
    id: page.id,
    clientName,
    country, // 여기에 국가 데이터 추가
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

    // Query 1: 급한 건
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
      { headers: notionHeaders() }
    );

    // Query 2: 보관 건 (보관유무 = Status)
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

    const [urgentRes, storageRes] = await Promise.all([urgentQuery, storageQuery]);

    const urgentData = urgentRes.data.results.map(formatNotionPage);
    const storageData = storageRes.data.results.map(formatNotionPage);

    res.json({ 
      ok: true, 
      targetName: salesRepName,
      data: {
        urgent: urgentData,
        storage: storageData
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
