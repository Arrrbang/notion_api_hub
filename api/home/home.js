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

// 1. 사용자 ID와 노션 '영업담당' 이름 매핑
const USER_MAPPING = {
  "admin": "정창락",
  // 추후 다른 사용자 추가 가능
};

// 2. 날짜 계산 함수
function getDateString(date) {
  return date.toISOString().split('T')[0];
}

// 3. 노션 페이지 데이터를 우리가 필요한 객체로 변환하는 헬퍼 함수
function formatNotionPage(page) {
  const props = page.properties;
  
  // 고객명
  const clientName = props["고객명"]?.title?.[0]?.plain_text || "이름 없음";
  
  // 업무담당 (여러 명일 수 있음)
  const assignees = props["업무담당"]?.people?.map(p => p.name).join(", ") || "배정 안됨";
  
  // 서류마감 (참고용)
  const deadline = props["서류마감"]?.date?.start || "";

  return {
    id: page.id,
    clientName,
    assignees,
    deadline
  };
}

router.get("/", async (req, res) => {
  try {
    const { username } = req.query;

    // 영업담당 이름 찾기
    const salesRepName = USER_MAPPING[username];

    if (!salesRepName) {
      return res.status(400).json({ 
        ok: false, 
        error: "매칭되는 영업담당자가 없습니다." 
      });
    }

    // 날짜 필터 준비
    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);

    const todayStr = getDateString(today);
    const nextWeekStr = getDateString(nextWeek);

    // ─────────────────────────────────────────────────────────────
    // [수정] 두 가지 쿼리를 병렬로 실행 (Promise.all)
    // ─────────────────────────────────────────────────────────────
    
    // Query 1: 급한 건 (기존 로직)
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

    // Query 2: 보관 중인 건 (신규 로직)
    // 조건: 영업담당 == 본인 AND 보관유무 == "보관"
    const storageQuery = axios.post(
        `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
        {
          filter: {
            and: [
              { property: "영업담당", select: { equals: salesRepName } },
              { property: "보관유무", select: { equals: "보관" } } 
            ]
          }
        },
        { headers: notionHeaders() }
      );

    // 두 요청 동시에 기다림
    const [urgentRes, storageRes] = await Promise.all([urgentQuery, storageQuery]);

    // 결과 데이터 정제
    const urgentData = urgentRes.data.results.map(formatNotionPage);
    const storageData = storageRes.data.results.map(formatNotionPage);

    // 응답 전송
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
    res.status(500).json({ ok: false, error: "데이터를 불러오는 중 오류가 발생했습니다." });
  }
});

module.exports = (app) => {
  app.use("/api/home", router);
};
