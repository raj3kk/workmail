// WorkMail Cloudflare API worker (D1-backed starter API).
//
// SINGLE-WORKSPACE / PRIVATE-TEST SIDECAR — NOT a multi-tenant API.
// It uses one shared APP_BEARER_TOKEN and D1 has no row-level security,
// so there is no per-user isolation here at all. The primary hosted
// product is the Vercel Next.js app (D1 + KV), which enforces tenant
// isolation in application code. Do not expose this worker publicly.
//
// CANONICAL SCHEMA: db/schema.sql is the only schema. There is no second
// schema file under cloudflare/ (the stale 0001-era subset was deleted).
// Every SQL statement below was checked against db/schema.sql:
//  - messages: mailbox_id, workspace_id, provider, message_id,
//    delivery_state, received_at, created_at (all present; mailbox_id is
//    NOT NULL, so a send with no resolved mailbox is rejected, never
//    inserted with a NULL mailbox_id).
//  - mailboxes: address, workspace_id, is_active.
//  - Delivery logging goes to delivery_events (id, workspace_id,
//    message_id, provider, provider_event_id, event_type, details,
//    occurred_at, created_at). Event_type 'accepted' = provider accepted
//    the send, 'rejected' = provider call failed.
//  - Error responses never leak raw D1 error strings.
//  - PATCH /api/messages/:id validates `folder` against an allowlist.
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type,Authorization,X-Inbound-Token","Access-Control-Allow-Methods":"GET,POST,PATCH,OPTIONS"};
const json=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{...cors,"Content-Type":"application/json"}});
const now=()=>new Date().toISOString(), uid=()=>crypto.randomUUID();
const FOLDERS=new Set(["inbox","sent","drafts","archive","trash"]);
const providers=env=>[["sendpulse",env.SENDPULSE_ID&&env.SENDPULSE_SECRET],["brevo",env.BREVO_API_KEY],["mailjet",env.MAILJET_API_KEY&&env.MAILJET_SECRET_KEY],["resend",env.RESEND_API_KEY],["gas",env.GAS_WEBHOOK_URL&&env.GAS_SECRET],["mailtrap",env.MAILTRAP_API_TOKEN],["smtp2go",env.SMTP2GO_API_KEY]].filter(x=>x[1]).map(x=>x[0]);
async function deliver(p,d,e){
 const {to,from,subject,text="",html=""}=d, name=d.senderName||"WorkMail";
 const call=async(url,init)=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),8000);try{return await fetch(url,{...init,signal:c.signal})}finally{clearTimeout(t)}};
 if(p==="sendpulse"){let a=await call("https://api.sendpulse.com/oauth/access_token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({grant_type:"client_credentials",client_id:e.SENDPULSE_ID,client_secret:e.SENDPULSE_SECRET})});if(!a.ok)throw Error("SendPulse auth "+a.status);let {access_token}=await a.json();let r=await call("https://api.sendpulse.com/smtp/emails",{method:"POST",headers:{"Authorization":"Bearer "+access_token,"Content-Type":"application/json"},body:JSON.stringify({email:{html:btoa(unescape(encodeURIComponent(html||text))),text,subject,from:{name,email:from},to:[{email:to}]}})});if(!r.ok)throw Error("SendPulse "+r.status);return r.json()}
 if(p==="brevo"){let r=await call("https://api.brevo.com/v3/smtp/email",{method:"POST",headers:{"api-key":e.BREVO_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({sender:{name,email:from},to:[{email:to}],subject,htmlContent:html,textContent:text})});if(!r.ok)throw Error("Brevo "+r.status);return r.json()}
 if(p==="mailjet"){let r=await call("https://api.mailjet.com/v3.1/send",{method:"POST",headers:{"Authorization":"Basic "+btoa(e.MAILJET_API_KEY+":"+e.MAILJET_SECRET_KEY),"Content-Type":"application/json"},body:JSON.stringify({Messages:[{From:{Email:from,Name:name},To:[{Email:to}],Subject:subject,HTMLPart:html,TextPart:text}]})});if(!r.ok)throw Error("Mailjet "+r.status);return r.json()}
 if(p==="mailtrap"){let r=await call("https://send.api.mailtrap.io/api/send",{method:"POST",headers:{"Authorization":"Bearer "+e.MAILTRAP_API_TOKEN,"Content-Type":"application/json"},body:JSON.stringify({from:{email:from,name},to:[{email:to}],subject,text,html})});if(!r.ok)throw Error("Mailtrap "+r.status);return r.json()}
 if(p==="smtp2go"){let r=await call("https://api.smtp2go.com/v3/email/send",{method:"POST",headers:{"X-Smtp2go-Api-Key":e.SMTP2GO_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({sender:from,to:[to],subject,text_body:text,html_body:html})});if(!r.ok)throw Error("SMTP2GO "+r.status);let d=await r.json();if(d?.data?.succeeded===0)throw Error("SMTP2GO rejected send");return d}
 if(p==="resend"){let r=await call("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+e.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:name+" <"+from+">",to:[to],subject,html,text})});if(!r.ok)throw Error("Resend "+r.status);return r.json()}
 let r=await call(e.GAS_WEBHOOK_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({secret:e.GAS_SECRET,...d})});if(!r.ok)throw Error("GAS "+r.status);return r.json();
}
async function findMailbox(env,address){
  if(!address)return null;
  return env.DB.prepare("SELECT id, workspace_id FROM mailboxes WHERE address=? AND is_active=1").bind(String(address).toLowerCase()).first();
}
async function logAttempt(env,{workspaceId,messageId,provider,state,responseCode,detail}){
  // delivery_events is the canonical delivery log (db/schema.sql).
  // event_type is CHECK-constrained: 'accepted' for a provider-accepted
  // send, 'rejected' for a failed provider call. provider_event_id must
  // be unique per provider, so each attempt gets a fresh id.
  const eventType = state === "accepted" ? "accepted" : "rejected";
  const details = JSON.stringify({state, response_code: responseCode || null, detail: String(detail || "").slice(0, 900)});
  await env.DB.prepare("INSERT INTO delivery_events(id,workspace_id,message_id,provider,provider_event_id,event_type,details,occurred_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(uid(),workspaceId,messageId,provider,uid(),eventType,details,now(),now()).run();
}
export default {async fetch(req,env){
 if(req.method==="OPTIONS")return new Response(null,{headers:cors});
 const u=new URL(req.url),auth=req.headers.get("Authorization");
 if(!env.APP_BEARER_TOKEN||auth!=="Bearer "+env.APP_BEARER_TOKEN)return json({error:"Unauthorized"},401);
 try{
 if(req.method==="GET"&&u.pathname==="/api/messages"){
   let f=u.searchParams.get("folder")||"inbox";
   if(!FOLDERS.has(f))return json({error:"Unknown folder"},400);
   let addr=u.searchParams.get("mailbox")||env.DEFAULT_MAILBOX||"";
   let box=await findMailbox(env,addr);
   if(!box)return json({messages:[]});
   let q=await env.DB.prepare("SELECT id,workspace_id,mailbox_id,folder,from_email,to_email,subject,is_read,received_at FROM messages WHERE folder=? AND mailbox_id=? ORDER BY received_at DESC LIMIT 100").bind(f,box.id).all();
   return json({messages:q.results});
 }
 if(req.method==="GET"&&u.pathname.startsWith("/api/messages/")){let id=u.pathname.split("/").pop(),m=await env.DB.prepare("SELECT id,workspace_id,mailbox_id,folder,from_email,to_email,subject,text_body,html_body,is_read,received_at FROM messages WHERE id=?").bind(id).first();return m?json({message:m}):json({error:"Not found"},404)}
 if(req.method==="PATCH"&&u.pathname.startsWith("/api/messages/")){
   let id=u.pathname.split("/").pop(),d=await req.json().catch(()=>({}));
   if(d.folder!==undefined&&!FOLDERS.has(d.folder))return json({error:"Unknown folder"},400);
   if(d.is_read!==undefined)await env.DB.prepare("UPDATE messages SET is_read=? WHERE id=?").bind(d.is_read?1:0,id).run();
   if(d.folder)await env.DB.prepare("UPDATE messages SET folder=? WHERE id=?").bind(d.folder,id).run();
   return json({success:true});
 }
 if(req.method==="POST"&&u.pathname==="/api/inbound"){
   if(!env.INBOUND_WEBHOOK_TOKEN||req.headers.get("X-Inbound-Token")!==env.INBOUND_WEBHOOK_TOKEN)return json({error:"Inbound unauthorized"},401);
   let d=await req.json(),id=uid();
   let box=await findMailbox(env,d.to);
   if(!box)return json({error:"Recipient mailbox not found"},404);
   await env.DB.prepare("INSERT INTO messages(id,workspace_id,mailbox_id,folder,from_email,to_email,subject,text_body,html_body,message_id,received_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,box.workspace_id,box.id,"inbox",d.from,d.to,d.subject||"",d.text||"",d.html||"",d.messageId||null,d.receivedAt||now(),now()).run();
   return json({success:true,id},201);
 }
 if(req.method==="POST"&&u.pathname==="/api/send"){
   let d=await req.json();
   if(!d.to||!d.from||!d.subject||(!d.text&&!d.html))return json({error:"Required: from,to,subject,text/html"},400);
   let box=await findMailbox(env,d.from);
   // messages.mailbox_id is NOT NULL in db/schema.sql, so a send with no
   // resolved sender mailbox cannot be stored — reject it instead of
   // inserting a NULL mailbox_id (which would 500 and, worse, could
   // misreport a successful provider send as a failure).
   if(!box)return json({error:"Sender mailbox not found; use a known mailbox address"},404);
   let workspaceId=box.workspace_id, mailboxId=box.id;
   let id=uid(),attempts=[];
   for(let p of providers(env)){
     try{
       let result=await deliver(p,d,env),mid=result?.messageId||result?.id||null;
       await env.DB.prepare("INSERT INTO messages(id,workspace_id,mailbox_id,folder,from_email,to_email,subject,text_body,html_body,provider,message_id,received_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,workspaceId,mailboxId,"sent",d.from,d.to,d.subject,d.text||"",d.html||"",p,mid,now(),now()).run();
       await logAttempt(env,{workspaceId,messageId:id,provider:p,state:"accepted",responseCode:200,detail:JSON.stringify(result).slice(0,900)});
       return json({success:true,provider:p,messageId:mid,attempts});
     }catch(err){
       attempts.push({provider:p,reason:String(err.message||err)});
       try{await logAttempt(env,{workspaceId,messageId:id,provider:p,state:"failed",responseCode:null,detail:String(err.message||err)});}catch{}
     }
   }
   return json({success:false,error:"All providers failed or none configured",attempts},502);
 }
 if(req.method==="GET"&&u.pathname==="/api/health")return json({ok:true,configuredProviders:providers(env)});
 return json({error:"Not found"},404)
 }catch(err){console.error("WorkMail worker error:",err);return json({error:"Internal error"},500)}
}};
