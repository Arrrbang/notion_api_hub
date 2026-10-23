/** 공통 직원 프로필/부서별 목록 API. 인증은 별도 서버에서 처리합니다. */
const users=require('./user_service');
module.exports=app=>{
 app.get('/api/user-info',async(req,res)=>{try{res.set('Cache-Control','no-store');res.json({ok:true,data:await users.getUser(req.query.pass_id)});}catch(e){users.handleError(res,e);}});
 app.get('/api/user-info/list',async(req,res)=>{try{res.set('Cache-Control','no-store');const data=await users.listUsers(req.query.department);res.json({ok:true,count:data.length,data});}catch(e){users.handleError(res,e);}});
};
