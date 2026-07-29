/* api/quotation/saveload.js */
const axios = require("axios");

const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
// 💡 전달해주신 노션 DB ID를 고정으로 삽입합니다.
const QUOTATION_DB_ID = '3aa0b10191ce80558a36d58c58c1df53';

function notionHeaders() {
    return {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
    };
}

// 💡 2000자 글자수 제한을 우회하기 위한 데이터 쪼개기 함수
function chunkString(str, length) {
    const chunks = [];
    for (let i = 0; i < str.length; i += length) {
        chunks.push(str.substring(i, i + length));
    }
    return chunks;
}

module.exports = function(app) {

    // =========================================================================
    // [1] 견적서 저장 및 번호 자동 생성 API
    // =========================================================================
    app.post('/api/quotation/save', async (req, res) => {
        try {
            const { quoteNo, customer, date, totalAmount, sales, rawData } = req.body;

            // 1. 날짜 포맷팅 (2026/07/27 (MON) -> 2026-07-27)
            let cleanDate = date ? date.replace(/\s*\(.*?\)\s*/g, '').replace(/\//g, '-').trim() : '';
            if (!cleanDate) {
                // 날짜가 없으면 한국 시간 기준 오늘 날짜 강제 생성
                const today = new Date();
                const kstOffset = 9 * 60 * 60 * 1000;
                cleanDate = new Date(today.getTime() + kstOffset).toISOString().split('T')[0];
            }

            let finalQuoteNo = quoteNo;

            // 2. Quote No가 비어있다면 자동 생성 (Sales이름-날짜-순번)
            if (!finalQuoteNo || finalQuoteNo.trim() === '') {
                const salesPrefix = sales ? sales.split(' ')[0].toUpperCase() : 'UNKNOWN';
                const dateStr = cleanDate.replace(/-/g, ''); // 20260727

                // 오늘 해당 영업사원이 작성한 견적서가 몇 개인지 노션 DB 검색
                const queryResp = await axios.post(`https://api.notion.com/v1/databases/${QUOTATION_DB_ID}/query`, {
                    filter: {
                        and: [
                            { property: "Sales", select: { equals: sales } },
                            { property: "Date", date: { equals: cleanDate } }
                        ]
                    }
                }, { headers: notionHeaders() });

                // 작성된 개수 + 1로 순번 지정 (01, 02 형식)
                const count = queryResp.data.results.length;
                const sequence = String(count + 1).padStart(2, '0');
                
                finalQuoteNo = `${salesPrefix}-${dateStr}-${sequence}`;
            }

            // 3. 데이터를 2000자 단위로 쪼개기 (노션 한계 돌파)
            const jsonString = JSON.stringify(rawData || {});
            const chunkedData = chunkString(jsonString, 2000).map(chunk => ({
                text: { content: chunk }
            }));

            // 4. 노션에 새 데이터 행(Page) 생성
            const createResp = await axios.post('https://api.notion.com/v1/pages', {
                parent: { database_id: QUOTATION_DB_ID },
                properties: {
                    "Quote No": { title: [{ text: { content: finalQuoteNo } }] },
                    "Customer": { rich_text: [{ text: { content: customer || 'Unknown' } }] },
                    "Date": { date: { start: cleanDate } },
                    "Total Amount": { number: Number(totalAmount) || 0 },
                    "Sales": { select: { name: sales || 'Unassigned' } },
                    "Raw Data": { rich_text: chunkedData }
                }
            }, { headers: notionHeaders() });

            res.json({ ok: true, quoteNo: finalQuoteNo, pageId: createResp.data.id });

        } catch (error) {
            console.error('견적 저장 에러:', error.response?.data || error.message);
            res.status(500).json({ ok: false, error: '견적서를 저장하지 못했습니다.' });
        }
    });

    // =========================================================================
    // [2] 특정 영업사원의 견적서 목록 불러오기 API
    // =========================================================================
    app.post('/api/quotation/list', async (req, res) => {
        try {
            const { sales } = req.body;

            // Sales 이름이 일치하는 항목만 조회 (최신순 정렬)
            const queryResp = await axios.post(`https://api.notion.com/v1/databases/${QUOTATION_DB_ID}/query`, {
                filter: sales ? { property: "Sales", select: { equals: sales } } : undefined,
                sorts: [{ property: "Date", direction: "descending" }]
            }, { headers: notionHeaders() });

            const results = queryResp.data.results.map(page => {
                const props = page.properties;
                
                // 쪼개져 있는 Raw Data 텍스트 블록들을 다시 하나로 합치기
                const rawDataArray = props["Raw Data"]?.rich_text || [];
                const fullRawDataStr = rawDataArray.map(t => t.plain_text).join('');
                
                let parsedData = {};
                try { parsedData = JSON.parse(fullRawDataStr); } catch(e) {}

                return {
                    id: page.id,
                    quoteNo: props["Quote No"]?.title[0]?.plain_text || '',
                    customer: props["Customer"]?.rich_text[0]?.plain_text || '',
                    date: props["Date"]?.date?.start || '',
                    totalAmount: props["Total Amount"]?.number || 0,
                    sales: props["Sales"]?.select?.name || '',
                    rawData: parsedData
                };
            });

            res.json({ ok: true, list: results });

        } catch (error) {
            console.error('견적 목록 조회 에러:', error.response?.data || error.message);
            res.status(500).json({ ok: false, error: '목록을 불러오지 못했습니다.' });
        }
    });

    // =========================================================================
    // [3] 견적서 영구 삭제(아카이브) API
    // =========================================================================
    app.delete('/api/quotation/delete/:id', async (req, res) => {
        try {
            const pageId = req.params.id;

            // 노션 API를 통해 해당 페이지를 '보관함(Archived)'으로 넘김으로써 삭제 처리
            await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, {
                archived: true
            }, { headers: notionHeaders() });

            res.json({ ok: true, message: '삭제 완료' });

        } catch (error) {
            console.error('견적 삭제 에러:', error.response?.data || error.message);
            res.status(500).json({ ok: false, error: '견적서를 삭제하지 못했습니다.' });
        }
    });

};
