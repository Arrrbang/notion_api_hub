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
  // 필요한 경우 다른 사용자 추가
  // "user1": "홍길동",
};

// 2. 날짜 계산 함수
function getDateString(date) {
  return date.toISOString().split('T')[0];
}

// 3. 노션 페이지 포맷팅 헬퍼
function formatNotionPage(page) {
  const props = page.properties;
  
  // 고객명 (Title)
  const clientName = props["고객명"]?.title?.[0]?.plain_text || "이름 없음";
  
  // 업무담당 (Person)
  const assignees = props["업무담당"]?.people?.map(p => p.name).join(", ") || "배정 안됨";
  
  // 서류마감 (Date) - 급한 건에서만 쓰이지만 포맷은 동일하게 가져옴
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

    const salesRepName = USER_MAPPING[username];

    if (!salesRepName) {
      return res.status(400).json({ 
        ok: false, 
        error: "매칭되는 영업담당자가 없습니다." 
      });
    }

    // 날짜 준비
    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);

    const todayStr = getDateString(today);
    const nextWeekStr = getDateString(nextWeek);

    // ─────────────────────────────────────────────────────────────
    // Query 1: 급한 건 (영업담당, 여권수취, 서류마감)
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
      { headers: notionHeaders() }
    );

    // ─────────────────────────────────────────────────────────────
    // Query 2: 보관 건 (영업담당, 보관유무)
    // [수정 완료] 보관유무는 Status 속성이므로 select 대신 status 사용
    // ─────────────────────────────────────────────────────────────
    const storageQuery = axios.post(
        `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
        {
          filter: {
            and: [
              { property: "영업담당", select: { equals: salesRepName } },
              { 
                property: "보관유무", 
                status: { equals: "보관" }  // <--- 여기가 수정된 핵심 포인트입니다!
              } 
            ]
          }
        },
        { headers: notionHeaders() }
      );

    // 두 요청 병렬 실행
    const [urgentRes, storageRes] = await Promise.all([urgentQuery, storageQuery]);

    // 데이터 정제
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
    
    // 에러 발생 시 상세 내용을 프론트엔드로 전달
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
