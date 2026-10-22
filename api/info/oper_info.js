/**
 * 로그인 아이디(PASS_ID 제목 속성)로 직원 DB의 한글명을 조회합니다.
 * sales_info.js와 같은 DB를 사용하며 하드코딩 이름 매핑은 없습니다.
 * GET /api/oper-info?pass_id=로그인아이디
 * 댓글 API는 lookupOperInfo 함수를 직접 재사용하여 서버에서 이름을 조회합니다.
 */
const axios=require('axios');
const OPER_DB_ID='3a50b10191ce80c8b560f043f9565688';
function error(status,message){return Object.assign(new Error(message),{status});}
function plain(prop){return (prop?.title || prop?.rich_text || []).map(t=>t.plain_text ?? t.text?.content ?? '').join('').trim();}
async function lookupOperInfo(passId) {
  if(typeof passId!=='string'||!passId.trim()||passId.trim().length>100||/[\r\n]/.test(passId))throw error(400,'로그인 아이디를 확인해 주세요.');
  const pass_id=passId.trim();
  const token=process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
  if(!token)throw error(500,'Notion API 연결 정보가 없습니다.');
  const pages=[];let cursor;
  do {
    const {data}=await axios.post(`https://api.notion.com/v1/databases/${OPER_DB_ID}/query`,{
      page_size:100,filter:{property:'PASS_ID',title:{equals:pass_id}},...(cursor?{start_cursor:cursor}:{})
    },{headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Notion-Version':'2022-06-28'},timeout:20000});
    pages.push(...(data.results || []));cursor=data.has_more?data.next_cursor:null;
  }while(cursor);
  if(!pages.length)throw error(404,'로그인 아이디에 해당하는 직원 정보가 없습니다. PASS_ID를 확인해 주세요.');
  if(pages.length>1)throw error(409,'동일한 PASS_ID가 여러 행에 등록되어 있습니다. 직원 DB를 확인해 주세요.');
  const page=pages[0],korean_name=plain(page.properties?.['한글명']);
  if(!korean_name)throw error(422,'해당 직원의 한글명이 비어 있습니다. 직원 DB를 확인해 주세요.');
  return{id:page.id,pass_id:plain(page.properties?.PASS_ID)||pass_id,korean_name};
}
function registerOperInfoRoutes(app) {
  app.get('/api/oper-info',async(req,res)=>{
    try{res.set('Cache-Control','no-store');res.json({ok:true,data:await lookupOperInfo(req.query.pass_id)});}
    catch(e){console.error('[oper_info]',e.response?.status || e.code || e.message);res.status(e.status || 500).json({ok:false,error:e.status?e.message:'직원 정보를 조회하지 못했습니다. DB 접근 권한을 확인해 주세요.'});}
  });
}
module.exports=registerOperInfoRoutes;
module.exports.lookupOperInfo=lookupOperInfo;
