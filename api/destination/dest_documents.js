/**
 * 단일 결과의 비용 관련 문서 조회 및 댓글 등록.
 * dest_table.js와 같은 필터로 실제 반환 비용행을 찾고 '파트너 연결'을 중복 제거합니다.
 * 문서 DB에서 파트너 관계가 일치하고 문서타입='비 용 관 련'인 페이지만 반환합니다.
 * 관계형/문서/본문 블록의 페이지네이션 처리, 문서 중복 제거, 본문 하위 블록 조회.
 * 댓글 본문 앞에 웹 로그인 아이디를 붙이고, Notion 연결 계정으로 페이지 댓글에 등록합니다.
 */
const axios=require('axios');
const {resolveTariffSelection,notionHelpers}=require('./dest_table');
const {queryAll,notionHeaders,normalizeId,getTitle}=notionHelpers;
const DOCUMENT_DB='34a0b10191ce800988a9dd777d4dc05c';
const DOC_TYPE='비 용 관 련';
const API='https://api.notion.com/v1';
async function get(path,params={}) {
  const {data}=await axios.get(`${API}${path}`,{headers:notionHeaders(),params,timeout:20000});return data;
}
async function relationIds(page) {
  const prop=page.properties?.['파트너 연결'];
  if(!prop)return [];
  const ids=(prop.relation || []).map(item=>item.id);
  if(prop.has_more && prop.id) {
    let cursor;
    do {
      const data=await get(`/pages/${page.id}/properties/${encodeURIComponent(decodeURIComponent(prop.id))}`,{page_size:100,...(cursor?{start_cursor:cursor}:{})});
      for(const item of data.results || [])if(item.relation?.id)ids.push(item.relation.id);
      cursor=data.has_more?data.next_cursor:null;
    }while(cursor);
  }
  return [...new Set(ids.map(normalizeId).filter(Boolean))];
}
async function documentsForSelection(query) {
  const {matched}=await resolveTariffSelection(query);
  const ids=new Set();
  for(const page of matched)for(const id of await relationIds(page))ids.add(id);
  if(!ids.size)return [];
  const docs=new Map(),partners=[...ids];
  for(let i=0;i<partners.length;i+=50) {
    const filter={and:[{property:'문서타입',select:{equals:DOC_TYPE}},
      {or:partners.slice(i,i+50).map(id=>({property:'파트너 연결',relation:{contains:id}}))}]};
    for(const page of await queryAll(DOCUMENT_DB,{filter})) {
      if(page.properties?.['문서타입']?.select?.name!==DOC_TYPE)continue;
      // 실제 속성도 확인합니다. 한 문서에 여러 매칭 파트너가 있어도 한 번만 반환.
      if((await relationIds(page)).some(id=>ids.has(id)))docs.set(normalizeId(page.id),page);
    }
  }
  return [...docs.values()];
}
function summary(page) {
  const prop=Object.values(page.properties || {}).find(p=>p.type==='title');
  const title=(prop?.title || []).map(t=>t.plain_text || t.text?.content || '').join('') || '제목 없음';
  return {id:page.id,title,url:page.url || `https://www.notion.so/${normalizeId(page.id)}`,
    updated:page.properties?.['업데이트일자']?.date?.start || page.last_edited_time || ''};
}
async function allowedDocument(query,pageId) {
  const id=normalizeId(pageId);
  if(!id)throw Object.assign(new Error('문서 ID가 올바르지 않습니다.'),{status:400});
  const page=(await documentsForSelection(query)).find(p=>normalizeId(p.id)===id);
  if(!page)throw Object.assign(new Error('현재 조회 결과에 연결된 비용 문서가 아닙니다.'),{status:404});
  return page;
}
async function readBody(pageId) {
  let remaining=1500,truncated=false;
  async function children(id,depth=0) {
    const blocks=[];let cursor;
    do {
      if(!remaining){truncated=true;break;}
      const data=await get(`/blocks/${id}/children`,{page_size:100,...(cursor?{start_cursor:cursor}:{})});
      for(const block of data.results || []) {
        if(!remaining){truncated=true;break;}
        --remaining;
        const node={id:block.id,type:block.type,data:block[block.type] || {},children:[]};
        if(block.has_children && !['child_page','child_database'].includes(block.type)) {
          if(depth<10)node.children=await children(block.id,depth+1);else truncated=true;
        }
        blocks.push(node);
      }
      cursor=data.has_more?data.next_cursor:null;
    }while(cursor);
    return blocks;
  }
  return {blocks:await children(pageId),get truncated(){return truncated;}};
}
function fail(res,e) {
  const code=e.status || (e.response?.status===403?403:500);
  console.error('[dest_documents]',e.response?.status || e.code || e.message);
  res.status(code).json({ok:false,error:e.status?e.message:code===403?'문서 또는 댓글 접근 권한이 없습니다. Notion 연결 권한을 확인해 주세요.':'비용 문서 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.'});
}
module.exports=function registerDestDocumentsRoutes(app) {
  app.get('/api/dest-rate/cost-documents',async(req,res)=>{
    try{res.set('Cache-Control','no-store');res.json({ok:true,documents:(await documentsForSelection(req.query)).map(summary).sort((a,b)=>a.title.localeCompare(b.title,'ko'))});}
    catch(e){fail(res,e);}
  });
  app.get('/api/dest-rate/cost-documents/:pageId',async(req,res)=>{
    try{res.set('Cache-Control','no-store');const page=await allowedDocument(req.query,req.params.pageId);res.json({ok:true,document:summary(page),...await readBody(page.id)});}
    catch(e){fail(res,e);}
  });
  app.post('/api/dest-rate/cost-documents/:pageId/comments',async(req,res)=>{
    try {
      res.set('Cache-Control','no-store');
      const text=typeof req.body?.text==='string'?req.body.text.trim():'';
      if(!text || text.length>10000)return res.status(400).json({ok:false,error:'댓글을 1~10,000자로 입력해 주세요.'});
      const username=typeof req.body?.username==='string'?req.body.username.trim():'';
      if(!username || username.length>100 || /[\r\n]/.test(username))return res.status(400).json({ok:false,error:'로그인 아이디를 확인해 주세요. 다시 로그인 후 등록해 주세요.'});
      const page=await allowedDocument(req.body?.selection || {},req.params.pageId);
      const commentText=`[${username}]\n${text}`;
      const rich_text=[];let chunk='';
      for(const char of commentText) {
        if(chunk.length+char.length>2000){rich_text.push({type:'text',text:{content:chunk}});chunk='';}
        chunk+=char;
      }
      if(chunk)rich_text.push({type:'text',text:{content:chunk}});
      const {data}=await axios.post(`${API}/comments`,{parent:{page_id:page.id},rich_text},{headers:notionHeaders(),timeout:20000});
      res.json({ok:true,comment:{id:data.id,createdTime:data.created_time,createdBy:data.created_by}});
    }catch(e){fail(res,e);}
  });
};
