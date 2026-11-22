"use client";
import {useEffect,useRef,useState} from "react";
import MailboxAvatar from "@/components/MailboxAvatar";
type Attachment={id:string;file_name:string;content_type:string;size_bytes:number;created_at:string;};
type Label={id:string;name:string;color:string;};
type Mail={id:string;workspace_id:string;mailbox_id?:string;from_email:string;to_email:string;subject:string;text_body:string;html_body?:string;is_read:boolean;is_starred?:boolean;is_important?:boolean;folder:string;delivery_state?:string;provider?:string;received_at:string;message_id?:string;thread_id?:string;in_reply_to?:string;attachments?:Attachment[];labels?:Label[];};
const folders=["inbox","sent","drafts","archive","trash","spam"];
const folderIcon:any={inbox:"▣",sent:"↗",drafts:"▤",archive:"▱",trash:"⌫",spam:"⊘"};
function fmtDate(v:string){const d=new Date(v);return isNaN(d.getTime())?"—":d.toLocaleDateString();}
function fmtDateTime(v:string){const d=new Date(v);return isNaN(d.getTime())?"—":d.toLocaleString();}
function quoteBody(m:Mail){const lines=(m.text_body||"").split("\n").map(l=>"> "+l).join("\n");return `\n\n— On ${fmtDateTime(m.received_at)}, ${m.from_email} wrote:\n${lines}`;}
// RULE 0: a message is SENT only when its own delivery_state says so.
// Never derive the badge from the sidebar folder state — a draft found
// via search while in Sent rendered as SENT that way (B-b).
function deliveryBadge(m:Mail):string{
 const s=(m.delivery_state||"").toLowerCase();
 if(s==="accepted"||s==="sent"||s==="delivered"||s==="opened"||s==="clicked")return "SENT";
 if(s==="draft")return "DRAFT";
 if(s==="failed"||s==="rejected")return "FAILED";
 if(s==="unknown")return "UNKNOWN";
 if(s==="bounced")return "BOUNCED";
 if(s==="complained")return "COMPLAINED";
 if(s==="deferred")return "DEFERRED";
 if(s==="received")return "RECEIVED";
 if(s)return s.toUpperCase();
 return m.folder==="drafts"?"DRAFT":m.folder.toUpperCase();
}
// True only for a row the provider actually accepted.
function isAcceptedRow(m:any):boolean{const s=String(m?.delivery_state||"").toLowerCase();return s==="accepted"||s==="sent"||s==="delivered"||s==="opened"||s==="clicked"||s==="deferred";}
export default function Home(){
 const [user,setUser]=useState<any>(null),[loading,setLoading]=useState(true),[sessionError,setSessionError]=useState(""),[folder,setFolder]=useState("inbox"),[messages,setMessages]=useState<Mail[]>([]),[total,setTotal]=useState(0),[hasMore,setHasMore]=useState(false),[loadingMore,setLoadingMore]=useState(false),[active,setActive]=useState<Mail|null>(null),[search,setSearch]=useState(""),[searchResults,setSearchResults]=useState<Mail[]|null>(null),[compose,setCompose]=useState(false),[to,setTo]=useState(""),[subject,setSubject]=useState(""),[body,setBody]=useState(""),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[mailboxes,setMailboxes]=useState<any[]>([]),[mailboxId,setMailboxId]=useState(""),[workspaceId,setWorkspaceId]=useState(""),[aiStatus,setAiStatus]=useState<any>(null),[aiBusy,setAiBusy]=useState(false),[aiPrompt,setAiPrompt]=useState(""),[aiQueue,setAiQueue]=useState<any[]>([]),[autoReply,setAutoReply]=useState(false),[isNarrow,setIsNarrow]=useState(false);
 const [counts,setCounts]=useState<Record<string,number>>({}),[starredOnly,setStarredOnly]=useState(false),[labels,setLabels]=useState<Label[]>([]),[newLabel,setNewLabel]=useState(""),[thread,setThread]=useState<Mail[]|null>(null),[threadOpen,setThreadOpen]=useState(false),[draftId,setDraftId]=useState<string|null>(null),[draftSaved,setDraftSaved]=useState(""),[replyThreadId,setReplyThreadId]=useState<string|null>(null),[replyInReplyTo,setReplyInReplyTo]=useState<string|null>(null),[attachFiles,setAttachFiles]=useState<any[]>([]),[sendProvider,setSendProvider]=useState("auto");
 // E2 — mailbox switcher + unified inbox: mailboxId may be "all"
 // (All Messages view). sendFromMailboxId is the mailbox a compose
 // sends FROM — the From picker default is the current mailbox (or
 // the first mailbox in All view); reply/forward set it to the
 // mailbox the original ARRIVED in (see openReply/openForward).
 const [sendFromMailboxId,setSendFromMailboxId]=useState("");
 // E4 — "Draft with AI" (BYOK) box state in compose.
 const [aiTopic,setAiTopic]=useState(""),[aiTone,setAiTone]=useState("friendly"),[aiByokBusy,setAiByokBusy]=useState(false);
 // E5-4 — forward-with-attachments re-upload in progress.
 const [forwarding,setForwarding]=useState(false);
 // First-mailbox fallback for draft auto-save when the switcher is on All.
 const mailboxesRef=useRef<any[]>([]);
 useEffect(()=>{mailboxesRef.current=mailboxes;},[mailboxes]);
 function effectiveFromId():string{
   if(sendFromMailboxId)return sendFromMailboxId;
   if(mailboxId&&mailboxId!=="all")return mailboxId;
   return mailboxesRef.current[0]?.id||mailboxes[0]?.id||"";
 }
 // Templates (Phase 1): compose picker. Picking a template fills the
 // subject from it and renders its HTML at send time; the message
 // textarea is then unused (the template is the content) and the
 // template's variables are filled below. Sender name + unsubscribe
 // are automatic and never shown as inputs.
 const [templates,setTemplates]=useState<any[]>([]),[composeTemplateId,setComposeTemplateId]=useState(""),[templateVars,setTemplateVars]=useState<Record<string,string>>({});
 async function loadTemplates(){if(!workspaceId)return;const r=await fetch(`/api/templates?workspace_id=${encodeURIComponent(workspaceId)}`);const d=await r.json().catch(()=>null);if(r.ok)setTemplates(d.templates||[]);}
 useEffect(()=>{if(compose&&workspaceId)loadTemplates();},[compose,workspaceId]);
 useEffect(()=>{if(!compose){setComposeTemplateId("");setTemplateVars({});}},[compose]);
 const selectedTemplate=templates.find((t:any)=>t.id===composeTemplateId)||null;
 const editableTemplateVars=selectedTemplate?((selectedTemplate.variables||[]).filter((v:string)=>v!=="sender_name"&&v!=="unsubscribe_url")):[];
 const listRef=useRef<HTMLDivElement|null>(null);
 // sentRef: set once a send is confirmed accepted, so a late auto-save
 // callback never recreates a draft for a finished compose (B-c).
 const sentRef=useRef(false);
 // saveInFlightRef: the single in-flight draft-create POST, so two
 // auto-save ticks can never create two drafts for one compose (B-c).
 const saveInFlightRef=useRef<Promise<string|null>|null>(null);
 // A fresh compose session starts unsent.
 useEffect(()=>{if(compose)sentRef.current=false;},[compose]);
 useEffect(()=>{const q=window.matchMedia("(max-width: 850px)");const f=()=>setIsNarrow(q.matches);f();q.addEventListener("change",f);return ()=>q.removeEventListener("change",f);},[]);
 useEffect(()=>{fetch("/api/auth/session").then(r=>r.json()).then(s=>{setUser(s.user||null);const w=s.workspaces?.[0];if(w?.id)setWorkspaceId(w.id);setLoading(false);}).catch(e=>{setSessionError(e?.message||"Could not reach the server. Check your connection and try again.");setLoading(false);});},[]);
 // Toast auto-dismiss (L-08): the notice clears itself after 7s.
 useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(""),7000);return ()=>clearTimeout(t);},[notice]);
 async function loadBoxes(){const r=await fetch("/api/mailboxes");const d=await r.json();setMailboxes(d.data||[]);if(!mailboxId&&d.data?.[0])setMailboxId(d.data[0].id);}
 useEffect(()=>{if(user)loadBoxes();},[user]);
 useEffect(()=>{if(!user||!workspaceId)return;fetch(`/api/ai/status?workspace_id=${encodeURIComponent(workspaceId)}`).then(r=>r.json()).then(s=>setAiStatus(s)).catch(()=>{});},[user,workspaceId]);
 async function loadAi(){if(!mailboxId||mailboxId==="all")return;const r=await fetch(`/api/ai/auto-reply?mailbox_id=${encodeURIComponent(mailboxId)}`);const d=await r.json();if(r.ok){setAutoReply(!!d.auto_reply?.enabled);setAiQueue(d.queue||[]);}}
 useEffect(()=>{if(user&&mailboxId)loadAi();},[user,mailboxId]);
 async function loadCounts(){if(!mailboxId)return;const r=await fetch(`/api/messages?mailbox_id=${encodeURIComponent(mailboxId)}&counts=1`);const d=await r.json();if(r.ok)setCounts(d.counts||{});}
 useEffect(()=>{if(user&&mailboxId)loadCounts();},[user,mailboxId]);
 async function loadLabels(){if(!workspaceId)return;const r=await fetch(`/api/labels?workspace_id=${encodeURIComponent(workspaceId)}`);const d=await r.json();if(r.ok)setLabels(d.labels||[]);}
 useEffect(()=>{if(workspaceId)loadLabels();},[workspaceId]);
 // Server-side search (wires /api/search into the inbox UI — L-12):
 // 2+ chars searches the whole mailbox, not just the loaded page.
 useEffect(()=>{const q=search.trim();if(q.length<2){setSearchResults(null);return;}if(!mailboxId)return;const t=setTimeout(async()=>{const r=await fetch(`/api/search?mailbox_id=${encodeURIComponent(mailboxId)}&q=${encodeURIComponent(q)}`);const d=await r.json();if(r.ok)setSearchResults(d.results||[]);},350);return ()=>clearTimeout(t);},[search,mailboxId]);
 async function refresh(offset=0,append=false){if(!user||!mailboxId)return;const star=starredOnly?"&starred=1":"";const r=await fetch(`/api/messages?mailbox_id=${encodeURIComponent(mailboxId)}&folder=${folder}${star}&limit=50&offset=${offset}`);const d=await r.json();if(!r.ok){setNotice(d.error||"Could not load messages");return;}const list=d.messages||[];setMessages(append?[...messages,...list]:list);setTotal(d.total||0);setHasMore(!!d.has_more);setActive(cur=>{const l=append?[...messages,...list]:list;return cur&&l.some((x:any)=>x.id===cur.id)?cur:l[0]||null;});loadCounts();}
 async function loadMore(){if(loadingMore||!hasMore)return;setLoadingMore(true);await refresh(messages.length,true);setLoadingMore(false);}
 useEffect(()=>{setMessages([]);setTotal(0);setHasMore(false);setActive(null);setThread(null);setThreadOpen(false);refresh();},[user,folder,mailboxId,starredOnly]);
 function signIn(){location.href="/api/auth/login";}
 async function uploadAttach(file:File,boxId?:string){const targetBox=boxId||mailboxId;if(!workspaceId||!targetBox||targetBox==="all"){setNotice("Pick a mailbox first (Settings → Mailboxes).");return;}const fd=new FormData();fd.append("file",file);fd.append("mailbox_id",targetBox);fd.append("workspace_id",workspaceId);const r=await fetch("/api/attachments",{method:"POST",body:fd});const d=await r.json();if(!r.ok){setNotice(d.error||"Attachment upload failed");return;}setAttachFiles(x=>[...x,d.attachment]);}
 // Await any in-flight draft-create POST and return the draft id it
 // produced (or the already-known one). Send must pass the real draft
 // id to /api/send so the server can delete it on accept (B-c race 1:
 // Send clicked while the first auto-save POST is still in flight).
 async function flushDraftSave():Promise<string|null>{
   if(saveInFlightRef.current){try{const id=await saveInFlightRef.current;if(id)return id;}catch{}}
   return draftId;
 }
 // Verify against the Sent list whether a matching accepted row landed.
 // Used when the send request itself timed out or its response was
 // lost: the server may still have accepted the send.
 async function checkSentFor(toAddr:string,subj:string):Promise<boolean>{
   try{
     const r=await fetch(`/api/messages?mailbox_id=${encodeURIComponent(mailboxId)}&folder=sent&limit=20`);
     const d=await r.json().catch(()=>null);
     if(!r.ok||!d)return false;
     return (d.messages||[]).some((m:any)=>m.to_email===toAddr&&m.subject===subj&&isAcceptedRow(m));
   }catch{return false;}
 }
 async function send(e:any){
   e.preventDefault();
   // E2: the send goes from the picked From mailbox (compose picker),
   // never from the switcher's "all" pseudo-mailbox.
   const fromBoxId=effectiveFromId();
   if(!user||!workspaceId||!mailboxId||!fromBoxId){setNotice("Pick a mailbox first (Settings → Mailboxes).");return;}
   if(busy)return;
   setBusy(true);
   // Capture the draft id at entry, then flush any in-flight auto-save
   // so the id sent to the server is the real one.
   let draftToDelete:string|null=draftId;
   try{const savedId=await flushDraftSave();if(savedId)draftToDelete=savedId;}catch{}
   const toAddr=to,subj=subject;
   // E5-10: plain-text signature of the sending mailbox, appended at
   // send time only (never stored in the draft). Template sends do not
   // carry the signature; HTML signatures are not supported.
   const sig=((mailboxes.find(b=>b.id===fromBoxId)?.signature)||"").trim();
   const bodyText=(!composeTemplateId&&sig)?body+"\n\n-- \n"+sig:body;
   const ctrl=new AbortController();
   const timer=setTimeout(()=>ctrl.abort(),25000);
   let out:any=null;let resOk=false;
   try{
     const res=await fetch("/api/send",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":crypto.randomUUID()},signal:ctrl.signal,body:JSON.stringify({to:toAddr,subject:subj,text:composeTemplateId?undefined:bodyText,workspace_id:workspaceId,mailbox_id:fromBoxId,thread_id:replyThreadId||undefined,in_reply_to:replyInReplyTo||undefined,provider:sendProvider,draft_id:draftToDelete||undefined,template_id:composeTemplateId||undefined,variables:composeTemplateId?templateVars:undefined})});
     resOk=res.ok;
     out=await res.json().catch(()=>null);
   }catch{
     // Timeout / network error: out stays null; verified below.
     out=null;
   }finally{
     clearTimeout(timer);
     setBusy(false);
   }
   // No usable response (timeout, dropped connection, or a 500 HTML
   // page that is not JSON — the old B-a hang): the server may still
   // have accepted the send, so verify against Sent before reporting
   // anything. The button is already unstuck (finally above).
   if(!out){
     const landed=await checkSentFor(toAddr,subj);
     if(landed){
       sentRef.current=true;
       setNotice("Sent — check Sent folder");
       setCompose(false);setTo("");setSubject("");setBody("");setDraftId("");setDraftSaved("");setReplyThreadId(null);setReplyInReplyTo(null);setAttachFiles([]);setAiTopic("");setSendFromMailboxId("");setFolder("sent");
     }else{
       setNotice("Send status unknown — check Sent before retrying, do not re-send blindly");
     }
     return;
   }
   // RULE 0: sent ONLY on a confirmed provider acceptance.
   const accepted=resOk&&out.success===true&&!!out.provider&&out.delivery_state==="accepted";
   if(!accepted){
     // Unknown (202) / failed / suppressed / rejected: keep the draft,
     // stay in compose, show the server error verbatim, NEVER go to Sent.
     setNotice(out.error||"Send failed — check Sent before retrying, do not re-send blindly");
     return;
   }
 sentRef.current=true;
 let note=`Message accepted by ${out.provider}.`;
 // Link compose attachments to the sent message record. The send
 // response now carries the D1 sent-row id (sent_message_id); fall
 // back to the newest matching to+subject row only if it is absent.
 if(attachFiles.length){
   try{
     let sentId:string|null=out.sent_message_id||null;
     if(!sentId){
       const lr=await fetch(`/api/messages?mailbox_id=${encodeURIComponent(fromBoxId)}&folder=sent&limit=5`);
       const ld=await lr.json().catch(()=>null);
       const sent=(ld?.messages||[]).find((m:any)=>m.to_email===toAddr&&m.subject===subj);
       sentId=sent?.id||null;
     }
     if(sentId){
       for(const a of attachFiles){
         await fetch(`/api/messages/${encodeURIComponent(sentId)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({attach:{object_key:a.object_key,file_name:a.file_name,content_type:a.content_type,size_bytes:a.size_bytes}})}).catch(()=>{});
       }
     }else{
       note+=" Attachments could not be linked to the sent record.";
     }
   }catch{
     note+=" Attachments could not be linked to the sent record.";
   }
 }
 // The server deletes the draft on accept; its response says whether
 // the draft is actually gone. Surface it honestly if it remains.
 if(draftToDelete&&out.draft_deleted===false)note+=" Sent, but the draft could not be removed — it is still in Drafts";
 setNotice(note);
 setCompose(false);setTo("");setSubject("");setBody("");setDraftId("");setDraftSaved("");setReplyThreadId(null);setReplyInReplyTo(null);setAttachFiles([]);setAiTopic("");setSendFromMailboxId("");setFolder("sent");}
 async function aiDraftCompose(){if(!to){setNotice("Add a recipient first, then ask AI to draft.");return;}const instruction=aiPrompt||body||subject||"Write a short professional email.";setAiBusy(true);const res=await fetch("/api/ai/draft-compose",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({workspace_id:workspaceId,mailbox_id:effectiveFromId(),to,subject,instruction})});const out=await res.json();setAiBusy(false);if(!res.ok){setNotice(out.error||"AI draft failed");return;}setBody(out.text);setNotice("AI draft ready — review it before sending.");}
 // E4 — "Draft with AI" (BYOK): short topic (+ tone) → POST
 // /api/ai/draft → {subject, body} filled into compose for review.
 // Nothing is sent automatically; the user edits and sends.
 async function aiDraftByok(){if(!aiTopic.trim()){setNotice("Type a short topic for the AI draft first.");return;}setAiByokBusy(true);const res=await fetch("/api/ai/draft",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({workspace_id:workspaceId,topic:aiTopic.trim(),tone:aiTone,to:to||undefined,subject:subject||undefined})});const out=await res.json().catch(()=>null);setAiByokBusy(false);if(!res.ok){setNotice(out?.error||"AI drafting failed");return;}if(!subject&&out.subject)setSubject(out.subject);setBody(out.body||"");setNotice(`AI draft ready (${out.provider} · ${out.model}) — review it before sending.`);}
 async function aiDraftReply(){if(!active)return;setAiBusy(true);const res=await fetch("/api/ai/draft-reply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message_id:active.id})});const out=await res.json();setAiBusy(false);if(!res.ok){setNotice(out.error||"AI reply failed");return;}setTo(out.to);setSubject(out.subject);setBody(out.text);setSendFromMailboxId(active.mailbox_id||mailboxId);setCompose(true);setNotice("AI reply draft ready — review it before sending.");}
 async function toggleAutoReply(){if(!mailboxId)return;const next=!autoReply;const r=await fetch("/api/ai/auto-reply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mailbox_id:mailboxId,enabled:next})});const d=await r.json();if(!r.ok){setNotice(d.error||"Could not change auto-reply");return;}setAutoReply(next);setNotice(next?"Auto-reply ON: incoming mail gets an AI reply sent automatically (max one per thread).":"Auto-reply OFF.");loadAi();}
 async function sendQueued(q:any){const r=await fetch(`/api/messages?mailbox_id=${encodeURIComponent(mailboxId)}&folder=drafts`);const d=await r.json();const draft=(d.messages||[]).find((m:any)=>m.id===q.draft_id);if(!draft){setNotice("Draft no longer in drafts folder.");return;}setBusy(true);const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),25000);let out:any=null;let resOk=false;try{const res=await fetch("/api/send",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":crypto.randomUUID()},signal:ctrl.signal,body:JSON.stringify({to:q.to,subject:q.subject,text:draft.text_body,workspace_id:workspaceId,mailbox_id:mailboxId,provider:"auto",draft_id:q.draft_id})});resOk=res.ok;out=await res.json().catch(()=>null);}catch{out=null;}finally{clearTimeout(timer);setBusy(false);}if(!(resOk&&out&&out.success===true&&out.provider&&out.delivery_state==="accepted")){setNotice(out?.error||"Send status unknown — check Sent before retrying, do not re-send blindly");return;}const sr=await fetch("/api/ai/auto-reply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"sent",draft_id:q.draft_id,workspace_id:workspaceId,provider:out.provider})}).catch(()=>null);if(!sr||!sr.ok){setNotice(`Sent via ${out.provider}, but the draft could not be removed — it is still in Drafts`);loadAi();return;}setNotice(`Sent via ${out.provider}.`);loadAi();setFolder("sent");}
 async function discardQueued(q:any){await fetch("/api/ai/auto-reply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"discard",draft_id:q.draft_id,workspace_id:workspaceId})});setNotice("AI draft discarded.");loadAi();}
 async function patchMessage(m:Mail,patch:any){try{const r=await fetch(`/api/messages/${encodeURIComponent(m.id)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(patch)});if(!r.ok){const d=await r.json().catch(()=>null);setNotice(d?.error||"Update failed");return null;}return await r.json().catch(()=>({}));}catch{setNotice("Update failed (network error)");return null;}}
 async function loadDetail(m:Mail){try{const r=await fetch(`/api/messages/${encodeURIComponent(m.id)}`);if(!r.ok)return;const d=await r.json();if(!d.message)return;const full:Mail={...m,...d.message,is_read:m.is_read,attachments:d.attachments||[],labels:d.labels||[]};setActive(cur=>cur?.id===m.id?full:cur);setMessages(x=>x.map(a=>a.id===m.id?{...a,...d.message,attachments:d.attachments||[],labels:d.labels||[]}:a));}catch{}}
 async function markRead(m:Mail){setActive(m);setThread(null);setThreadOpen(false);loadDetail(m);if(!m.is_read){if(await patchMessage(m,{is_read:true})){setMessages(x=>x.map(a=>a.id===m.id?{...a,is_read:true}:a));loadCounts();}}}
 function textPreview(m:Mail){if(m.text_body)return m.text_body.slice(0,100);if(m.html_body)return m.html_body.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim().slice(0,100);return "";}
 async function moveMessage(m:Mail,nextFolder:string){if(!await patchMessage(m,{folder:nextFolder}))return;setMessages(x=>x.filter(a=>a.id!==m.id));setActive(null);setThread(null);setThreadOpen(false);setNotice(`Message moved to ${nextFolder}.`);loadCounts();}
 async function toggleStar(m:Mail){const next=!m.is_starred;if(await patchMessage(m,{is_starred:next})){setMessages(x=>x.map(a=>a.id===m.id?{...a,is_starred:next}:a));if(active?.id===m.id)setActive({...active,is_starred:next});loadCounts();}}
 async function toggleImportant(m:Mail){const next=!m.is_important;if(await patchMessage(m,{is_important:next})){setMessages(x=>x.map(a=>a.id===m.id?{...a,is_important:next}:a));if(active?.id===m.id)setActive({...active,is_important:next});}}
 async function markUnread(m:Mail){if(await patchMessage(m,{is_read:false})){setMessages(x=>x.map(a=>a.id===m.id?{...a,is_read:false}:a));if(active?.id===m.id)setActive({...active,is_read:false});loadCounts();setNotice("Marked unread.");}}
 async function setLabelsFor(m:Mail,labelIds:string[]){const out=await patchMessage(m,{labels:labelIds});if(out)setActive(cur=>cur?.id===m.id?{...cur,labels:out.labels||[]}:cur);}
 async function createLabel(){if(!newLabel.trim()||!workspaceId)return;const r=await fetch("/api/labels",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({workspace_id:workspaceId,name:newLabel.trim()})});const d=await r.json();if(!r.ok){setNotice(d.error||"Could not create label");return;}setNewLabel("");loadLabels();setNotice(`Label “${d.label.name}” created.`);}
 async function loadThread(m:Mail){if(!m.thread_id){setNotice("This message has no thread.");return;}const boxId=m.mailbox_id||mailboxId;const r=await fetch(`/api/threads?mailbox_id=${encodeURIComponent(boxId)}&thread_id=${encodeURIComponent(m.thread_id)}`);const d=await r.json();if(!r.ok){setNotice(d.error||"Could not load thread");return;}setThread(d.messages||[]);setThreadOpen(true);}
 function openReply(m:Mail,all:boolean){const own=mailboxes.find(b=>b.id===mailboxId)?.address||"";const replyTo=all&&m.to_email&&m.to_email.toLowerCase()!==own.toLowerCase()?`${m.from_email}, ${m.to_email}`:m.from_email;setTo(replyTo);setSubject(m.subject?.startsWith("Re: ")?m.subject:"Re: "+(m.subject||"(No Subject)"));setBody(quoteBody(m));setReplyThreadId(m.thread_id||null);setReplyInReplyTo(m.message_id||null);setDraftId(null);
 // E2: reply sends FROM the mailbox the original arrived in — in
 // All view that is the message's own mailbox, not the switcher's.
 setSendFromMailboxId(m.mailbox_id||mailboxId);
 setCompose(true);}
 async function openForward(m:Mail){setTo("");setSubject(m.subject?.startsWith("Fwd: ")?m.subject:"Fwd: "+(m.subject||"(No Subject)"));setBody(`\n\n— Forwarded message —\nFrom: ${m.from_email}\nTo: ${m.to_email}\nDate: ${fmtDateTime(m.received_at)}\nSubject: ${m.subject||"(no subject)"}\n${m.text_body||""}`);setReplyThreadId(null);setReplyInReplyTo(null);setDraftId(null);
 // E2: forward sends FROM the mailbox the original arrived in.
 const recvBox=m.mailbox_id||mailboxId;
 setSendFromMailboxId(recvBox);
 setCompose(true);
 // E5-4: carry the original's attachments on the forward. The
 // original's bytes live in KV; re-upload each one through the same
 // /api/attachments path compose uses, so the forwarded draft carries
 // them and the send links them to the sent record as usual.
 setAttachFiles([]);
 let atts:Attachment[]|undefined=m.attachments;
 if(!atts||!atts.length){
   try{
     const r=await fetch(`/api/messages/${encodeURIComponent(m.id)}`);
     const d=await r.json().catch(()=>null);
     if(r.ok&&Array.isArray(d.attachments))atts=d.attachments;
   }catch{}
 }
 if(!atts||!atts.length)return;
 setForwarding(true);
 let failed=0;
 for(const a of atts){
   try{
     if(a.size_bytes>25*1024*1024){failed++;continue;}
     const r=await fetch(`/api/attachments?id=${encodeURIComponent(a.id)}&workspace_id=${encodeURIComponent(m.workspace_id)}`);
     if(!r.ok){failed++;continue;}
     const blob=await r.blob();
     await uploadAttach(new File([blob],a.file_name,{type:a.content_type||blob.type||"application/octet-stream"}),recvBox);
   }catch{failed++;}
 }
 setForwarding(false);
 if(failed>0)setNotice(`${failed} attachment${failed===1?"":"s"} could not be carried over to the forward — the rest are attached.`);}
 function openDraft(m:Mail){setTo(m.to_email||"");setSubject(m.subject||"");setBody(m.text_body||"");setDraftId(m.id);setReplyThreadId(m.thread_id||null);setReplyInReplyTo(m.in_reply_to||null);setSendFromMailboxId(m.mailbox_id||mailboxId);setCompose(true);}
 // Drafts auto-save: debounced 1.5s while compose is open. First save
 // creates the draft (POST /api/drafts), later saves PATCH it. Reopening
 // a draft from the Drafts folder restores its content (openDraft).
 // Guards (B-c): a late callback never saves after compose closed or
 // after the send completed (sentRef), and concurrent POSTs are
 // de-duplicated through one shared in-flight promise, so two drafts
 // can never be created for one compose session.
 const draftState=useRef({to,subject,body,draftId,replyThreadId,replyInReplyTo,compose,sendFromMailboxId});
 useEffect(()=>{draftState.current={to,subject,body,draftId,replyThreadId,replyInReplyTo,compose,sendFromMailboxId};},[to,subject,body,draftId,replyThreadId,replyInReplyTo,compose,sendFromMailboxId]);
 useEffect(()=>{if(!compose)return;if(!to&&!subject&&!body)return;const t=setTimeout(async()=>{const s=draftState.current;if(!s.compose||sentRef.current)return;if(!s.to&&!s.subject&&!s.body)return;let boxId=s.sendFromMailboxId||mailboxId;if(boxId==="all")boxId=mailboxesRef.current[0]?.id||"";if(!workspaceId||!boxId)return;try{if(!s.draftId){if(saveInFlightRef.current)return;const p=(async()=>{const r=await fetch("/api/drafts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({workspace_id:workspaceId,mailbox_id:boxId,to:s.to,subject:s.subject,text:s.body,thread_id:s.replyThreadId||undefined,in_reply_to:s.replyInReplyTo||undefined})});const d=await r.json().catch(()=>null);if(r.ok&&d?.draft_id){if(!sentRef.current&&draftState.current.compose){setDraftId(d.draft_id);setDraftSaved("Draft saved "+new Date().toLocaleTimeString());}return d.draft_id as string;}return null;})();saveInFlightRef.current=p;try{await p;}catch{}finally{if(saveInFlightRef.current===p)saveInFlightRef.current=null;}}else{const r=await fetch("/api/drafts",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:s.draftId,to:s.to,subject:s.subject,text:s.body})});if(r.ok&&!sentRef.current)setDraftSaved("Draft saved "+new Date().toLocaleTimeString());}}catch{}},1500);return ()=>clearTimeout(t);},[compose,to,subject,body]);
 async function discardDraft(){if(draftId){try{const r=await fetch(`/api/messages/${encodeURIComponent(draftId)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({folder:"trash"})});if(!r.ok){setNotice("Could not discard the draft — it is still in Drafts.");return;}}catch{setNotice("Could not discard the draft — it is still in Drafts.");return;}}setCompose(false);setTo("");setSubject("");setBody("");setDraftId("");setDraftSaved("");setReplyThreadId(null);setReplyInReplyTo(null);setAttachFiles([]);setNotice("Draft discarded.");}
 async function signOut(){await fetch("/api/auth/logout",{method:"POST"});setUser(null);}
 // Keyboard shortcuts (j/k navigate, r reply, e archive, u mark unread).
 // Ignored while typing in an input/textarea/select or while compose is open.
 useEffect(()=>{function onKey(e:KeyboardEvent){const t=e.target as HTMLElement;if(t&&(t.tagName==="INPUT"||t.tagName==="TEXTAREA"||t.tagName==="SELECT"||t.isContentEditable))return;if(compose)return;if(e.metaKey||e.ctrlKey||e.altKey)return;const list=searchResults||messages;if(e.key==="j"||e.key==="k"){if(!list.length)return;const idx=active?list.findIndex(m=>m.id===active.id):-1;const next=e.key==="j"?Math.min(idx+1,list.length-1):Math.max(idx-1,0);if(next>=0&&list[next])markRead(list[next]);}else if(e.key==="r"&&active){openReply(active,false);}else if(e.key==="e"&&active){moveMessage(active,"archive");}else if(e.key==="u"&&active){markUnread(active);}}window.addEventListener("keydown",onKey);return ()=>window.removeEventListener("keydown",onKey);},[messages,searchResults,active,compose]);
 if(loading)return <main className="center">Loading WorkMail…</main>;
 if(!user)return <main className="login"><div className="loginCard"><div className="logo">W</div><p className="eyebrow">CUSTOM DOMAIN EMAIL</p><h1>Your business, in one inbox.</h1><p className="muted">A focused email workspace for your own domain, with provider failover and serverless infrastructure.</p><button className="primary wide" onClick={signIn}>Continue with Google</button>{sessionError&&<p className="loginError">{sessionError}</p>}<small>Google login is only for WorkMail identity. It does not grant Gmail inbox access.</small><small><a href="/privacy">Privacy Policy</a></small></div></main>;
 const shown=searchResults||messages;
 const readerInner=active?<><div className="readerActions"><button onClick={()=>moveMessage(active,"archive")}>Archive</button><button onClick={()=>moveMessage(active,"trash")}>Move to trash</button><button onClick={()=>moveMessage(active,"spam")}>Report spam</button>{active.folder==="trash"&&<button onClick={()=>moveMessage(active,"inbox")}>Restore to inbox</button>}{active.folder==="spam"&&<button onClick={()=>moveMessage(active,"inbox")}>Not spam</button>}<button onClick={()=>toggleStar(active)} aria-label={active.is_starred?"Unstar message":"Star message"}>{active.is_starred?"★ Starred":"☆ Star"}</button><button onClick={()=>toggleImportant(active)} aria-label={active.is_important?"Remove important mark":"Mark as important"}>{active.is_important?"◆ Important":"◇ Important"}</button><button onClick={()=>markUnread(active)}>Mark unread</button><button onClick={()=>{openReply(active,false)}}>↩ Reply</button><button onClick={()=>{openReply(active,true)}}>↩ Reply all</button><button onClick={()=>{openForward(active)}}>↪ Forward</button><button disabled={aiBusy} onClick={aiDraftReply}>✦ AI reply</button></div><div className="readerBody"><span className="tag">{deliveryBadge(active)}</span>{active.labels&&active.labels.length>0&&<span style={{marginLeft:8}}>{active.labels.map(l=><span key={l.id} className="labelChip" style={{background:l.color}}>{l.name}</span>)}</span>}<h2>{active.subject||"(no subject)"}</h2>{mailboxId==="all"&&active.mailbox_id&&<small style={{display:"block",color:"#96a8c3",marginTop:4}}>Received in {mailboxes.find(b=>b.id===active.mailbox_id)?.address||active.mailbox_id} — replies send from that mailbox.</small>}<div className="sender">{(()=>{const own=mailboxes.find(b=>b.address.toLowerCase()===active.from_email.toLowerCase());return own?<MailboxAvatar mailboxId={own.id} address={own.address} />:<div className="avatar">{active.from_email[0].toUpperCase()}</div>;})()}<div><b>{active.from_email}</b><small>To: {active.to_email}</small></div><time>{fmtDateTime(active.received_at)}</time></div>{active.thread_id&&<div style={{marginTop:14}}><button onClick={()=>threadOpen?setThreadOpen(false):loadThread(active)}>{threadOpen?"Hide thread":`View thread${thread?` (${thread.length})`:""}`}</button>{threadOpen&&thread&&thread.map(tm=><div key={tm.id} className={"threadItem "+(tm.id===active.id?"active":"")} onClick={()=>markRead(tm)}><b>{tm.subject||"(no subject)"}</b><br/><small>{tm.from_email} · {fmtDateTime(tm.received_at)}</small></div>)}</div>}{active.text_body?<p className="bodyText">{active.text_body}</p>:active.html_body?<iframe title="Message content" sandbox="" srcDoc={active.html_body} style={{width:"100%",minHeight:420,border:"1px solid #283a55",borderRadius:8,background:"#fff",marginTop:25}}/>:<p className="bodyText">This message has no readable content.</p>}{active.attachments&&active.attachments.length>0&&<div style={{marginTop:22,borderTop:"1px solid #283a55",paddingTop:16}}><b style={{fontSize:12}}>Attachments ({active.attachments.length})</b>{active.attachments.map(a=><div key={a.id} style={{marginTop:8}}><a style={{color:"#a7bdff",fontSize:12}} href={`/api/attachments?id=${encodeURIComponent(a.id)}&workspace_id=${encodeURIComponent(active.workspace_id)}`}>{a.file_name} ({Math.round(a.size_bytes/1024)} KB)</a></div>)}</div>}<div style={{marginTop:22,borderTop:"1px solid #283a55",paddingTop:14}}><label style={{fontSize:11,color:"#bdcce0"}}>Labels <select value="" onChange={e=>{if(!e.target.value)return;const cur=(active.labels||[]).map(l=>l.id);if(!cur.includes(e.target.value))setLabelsFor(active,[...cur,e.target.value]);}} style={{marginLeft:8}}><option value="">Add label…</option>{labels.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>{active.labels&&active.labels.map(l=><button key={l.id} style={{marginLeft:6,fontSize:11}} onClick={()=>setLabelsFor(active,(active.labels||[]).filter(x=>x.id!==l.id).map(x=>x.id))}>× {l.name}</button>)}<span style={{marginLeft:10}}><input value={newLabel} onChange={e=>setNewLabel(e.target.value)} placeholder="New label" style={{width:110,display:"inline-block"}}/> <button onClick={createLabel}>Create</button></span></div></div></>:<div className="empty readerEmpty"><div className="emptyIcon">✉</div><b>Select a message</b><p>Choose a message to read it here.</p></div>;
 return <main className="shell"><aside className="sidebar"><div className="brand"><span className="logo smallLogo">W</span><span><b>WorkMail</b><small>BUSINESS MAIL</small></span></div><button className="primary compose" title="Compose new message" aria-label="Compose new message" onClick={()=>{setTo("");setSubject("");setBody("");setDraftId("");setReplyThreadId(null);setReplyInReplyTo(null);setAttachFiles([]);setAiTopic("");setSendFromMailboxId(mailboxId==="all"?(mailboxes[0]?.id||""):mailboxId);setCompose(true);}}>＋ Compose</button><div className="navLabel">MAILBOX</div>{mailboxes.length>0&&<select value={mailboxId} onChange={e=>setMailboxId(e.target.value)} aria-label="Choose mailbox"><option value="all">✉ All Messages</option>{mailboxes.map(b=><option key={b.id} value={b.id}>{b.address}</option>)}</select>}{folders.map(f=><button key={f} className={"nav "+(folder===f&&!starredOnly?"selected":"")} title={f[0].toUpperCase()+f.slice(1)} aria-label={f[0].toUpperCase()+f.slice(1)+(counts[f]?`, ${counts[f]} unread`:"")} onClick={()=>{setStarredOnly(false);setFolder(f);}}><span>{folderIcon[f]}</span>{f[0].toUpperCase()+f.slice(1)}{counts[f]>0&&<span style={{marginLeft:"auto",fontSize:10,background:"#a7bdff",color:"#101a30",borderRadius:10,padding:"1px 7px"}}>{counts[f]}</span>}</button>)}<button className={"nav "+(starredOnly?"selected":"")} title="Starred" aria-label={"Starred"+(counts.starred?`, ${counts.starred} unread`:"")} onClick={()=>{setStarredOnly(true);}}><span>★</span>Starred{counts.starred>0&&<span style={{marginLeft:"auto",fontSize:10,background:"#a7bdff",color:"#101a30",borderRadius:10,padding:"1px 7px"}}>{counts.starred}</span>}</button><div className="navLabel">WORKSPACE</div><button className="nav" title="Settings" aria-label="Settings" onClick={()=>location.href="/settings"}>⚙ Settings</button><button className="nav" title="Dashboard" aria-label="Dashboard" onClick={()=>location.href="/dashboard"}>▤ Dashboard</button><button className="nav" title="Bulk send" aria-label="Bulk send" onClick={()=>location.href="/bulk"}>✉ Bulk send</button><button className="nav" title="Templates" aria-label="Templates" onClick={()=>location.href="/templates"}>▦ Templates</button><div className="navLabel">AI AGENT</div><div className="account"><div><b>{aiStatus?(aiStatus.configured?`AI: ${aiStatus.provider}`:"AI: not configured"):"AI: …"}</b><small>{aiStatus&&!aiStatus.configured?"Set AI_PROVIDER_API_KEY, or use Cloudflare Workers AI":aiStatus?.model||""}</small></div></div>{mailboxId&&mailboxId!=="all"&&<button className="nav" onClick={toggleAutoReply}>{autoReply?"✦ Auto-reply: ON":"✦ Auto-reply: OFF"}</button>}{aiQueue.filter((q:any)=>q.status==="pending").map((q:any)=><div key={q.draft_id} className="account"><div><b>{q.subject}</b><small>To: {q.to}{q.auto?" • auto-draft":""}</small></div><button onClick={()=>sendQueued(q)} aria-label="Send queued AI draft">Send</button><button onClick={()=>discardQueued(q)} aria-label="Discard queued AI draft">×</button></div>)}<div className="account"><div className="avatar">{(user.email||"W")[0].toUpperCase()}</div><div><b>{user.email}</b><small>Signed in</small></div><button onClick={signOut} title="Sign out" aria-label="Sign out">↪</button></div></aside>
 <section className="content"><header className="header"><div><div className="eyebrow">WORKSPACE / MAIL</div><h1>{starredOnly?"Starred":folder[0].toUpperCase()+folder.slice(1)}</h1></div><div className="headerRight">{mailboxId&&mailboxId!=="all"&&<MailboxAvatar mailboxId={mailboxId} address={mailboxes.find(b=>b.id===mailboxId)?.address||""} />}{mailboxes.length>0&&<select className="mobileMailbox" value={mailboxId} onChange={e=>setMailboxId(e.target.value)} aria-label="Choose mailbox"><option value="all">✉ All Messages</option>{mailboxes.map(b=><option key={b.id} value={b.id}>{b.address}</option>)}</select>}<span className="secure">● Secure session</span><button className="iconBtn" title="Refresh" aria-label="Refresh" onClick={()=>refresh()}>↻</button></div></header>
 <div className="mailLayout"><section className="list"><div className="search" style={{display:"flex",gap:8,alignItems:"center"}}><span aria-hidden="true">📬</span><select value={mailboxId} onChange={e=>setMailboxId(e.target.value)} aria-label="Mailbox switcher" style={{flex:1}}><option value="all">All Messages — every mailbox</option>{mailboxes.map(b=><option key={b.id} value={b.id}>{b.address}</option>)}</select></div><div className="search"><input placeholder="Search messages…" value={search} onChange={e=>setSearch(e.target.value)} aria-label="Search messages"/></div><div className="listHeader"><b>{searchResults?`${searchResults.length} search results`:starredOnly?`${total} starred`:`${total} messages`}</b><button onClick={()=>refresh()}>Refresh</button></div><div ref={listRef}>{shown.map(m=><div key={m.id} role="button" tabIndex={0} className={"mailItem "+(active?.id===m.id?"active":"")} onClick={()=>m.folder==="drafts"||m.delivery_state==="draft"?openDraft(m):markRead(m)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();m.folder==="drafts"||m.delivery_state==="draft"?openDraft(m):markRead(m);}}}><div className="mailRow"><b>{m.is_starred?"★ ":""}{m.is_important?"◆ ":""}{m.from_email}</b><time>{fmtDate(m.received_at)}</time></div><strong>{m.subject||"(no subject)"}</strong><p>{textPreview(m)||"No plain-text preview"}</p><span className="tag">{deliveryBadge(m)}</span>{mailboxId==="all"&&m.mailbox_id&&<span className="labelChip" style={{background:"#283a55",marginLeft:6}}>{mailboxes.find(b=>b.id===m.mailbox_id)?.address||m.mailbox_id}</span>}{m.labels&&m.labels.length>0&&<div>{m.labels.map(l=><span key={l.id} className="labelChip" style={{background:l.color}}>{l.name}</span>)}</div>}{!m.is_read&&<i className="unread"/>}</div>)}{!shown.length&&<div className="empty"><b>No messages here</b><p>{searchResults?"No messages match that search.":"New messages will appear in this folder."}</p></div>}{!searchResults&&hasMore&&<div style={{padding:14,textAlign:"center"}}><button onClick={loadMore} disabled={loadingMore}>{loadingMore?"Loading…":`Load more (${total-messages.length} remaining)`}</button></div>}</div></section>
 {!isNarrow&&<article className="reader">{readerInner}</article>}{isNarrow&&active&&<div className="mobileReader"><div className="mobileReaderBar"><b>Message</b><button onClick={()=>setActive(null)}>✕ Close</button></div><div className="mobileReaderBody">{readerInner}</div></div>}</div>{notice&&<div className="notice" onClick={()=>setNotice("")}>{notice}　×</div>}</section>
 {compose&&<div className="backdrop"><form className="composeModal" onSubmit={send}><header><span style={{display:"flex",alignItems:"center",gap:10}}><b>{draftId?"Edit draft":"New message"}</b>{effectiveFromId()&&<MailboxAvatar mailboxId={effectiveFromId()} address={mailboxes.find(b=>b.id===effectiveFromId())?.address||""} />}</span><button type="button" onClick={()=>setCompose(false)}>×</button></header><label>From<select value={effectiveFromId()} onChange={e=>setSendFromMailboxId(e.target.value)} aria-label="Send from mailbox">{mailboxes.map(b=><option key={b.id} value={b.id}>{b.display_name?`${b.display_name} <${b.address}>`:b.address}</option>)}</select></label><small style={{display:"block",marginTop:4,color:"#96a8c3"}}>Reply and forward send from the mailbox the original arrived in — change it here if needed.</small><label>To<input type="email" required value={to} onChange={e=>setTo(e.target.value)} placeholder="recipient@example.com"/></label><label>Subject<input required value={subject} onChange={e=>setSubject(e.target.value)} placeholder="Subject"/></label><label>Template<select value={composeTemplateId} onChange={e=>{const id=e.target.value;setComposeTemplateId(id);setTemplateVars({});if(id){const t=templates.find((x:any)=>x.id===id);if(t&&!subject)setSubject(t.subject);}}} aria-label="Email template"><option value="">No template — plain text</option>{templates.map((t:any)=><option key={t.id} value={t.id}>{t.name} ({t.category}){t.is_default?" — default":""}</option>)}</select></label>{selectedTemplate&&<small style={{display:"block",marginTop:4,color:"#96a8c3"}}>Template “{selectedTemplate.name}” will render at send time. The message box below is not used — fill the template variables instead.</small>}{selectedTemplate&&editableTemplateVars.map((v:string)=><label key={v}>Variable: {`{{${v}}}`}<input value={templateVars[v]||""} onChange={e=>setTemplateVars({...templateVars,[v]:e.target.value})} /></label>)}<textarea required={!composeTemplateId} value={body} onChange={e=>setBody(e.target.value)} placeholder="Write your message…"/><label>Attach files (max 25 MB each)<input type="file" multiple onChange={e=>{const f=e.target.files;if(f)for(const file of Array.from(f))uploadAttach(file);e.target.value="";}}/></label>{attachFiles.length>0&&<div style={{fontSize:11,color:"#bdcce0"}}>{attachFiles.map((a,i)=><div key={i}>{a.file_name} ({Math.round(a.size_bytes/1024)} KB) <button type="button" onClick={()=>setAttachFiles(x=>x.filter((_,j)=>j!==i))}>×</button></div>)}</div>}<label>Provider<select value={sendProvider} onChange={e=>setSendProvider(e.target.value)} aria-label="Send provider"><option value="auto">Auto (fallback chain)</option><option value="sendpulse">SendPulse</option><option value="brevo">Brevo</option><option value="mailjet">Mailjet</option><option value="resend">Resend</option></select></label><small style={{display:"block",marginTop:4,color:"#96a8c3"}}>Auto tries SendPulse → Brevo → Mailjet → Resend. A manual pick sends only from that provider.</small><label>AI instruction<input value={aiPrompt} onChange={e=>setAiPrompt(e.target.value)} placeholder="e.g. Confirm receipt and ask for the invoice"/></label><button type="button" disabled={aiBusy} onClick={aiDraftCompose}>✦ AI draft</button><div style={{borderTop:"1px solid #283a55",marginTop:10,paddingTop:10}}><b style={{fontSize:12}}>✦ Draft with AI (your own key)</b><label>Topic<input value={aiTopic} onChange={e=>setAiTopic(e.target.value)} placeholder="e.g. Confirm the order and ask for the delivery date"/></label><label>Tone<select value={aiTone} onChange={e=>setAiTone(e.target.value)}><option value="friendly">Friendly</option><option value="formal">Formal</option><option value="short">Short</option></select></label><button type="button" disabled={aiByokBusy} onClick={aiDraftByok}>{aiByokBusy?"Drafting…":"Draft with AI"}</button>{forwarding&&<small style={{display:"block",marginTop:4,color:"#96a8c3"}}>Carrying over the original attachments…</small>}<small style={{display:"block",marginTop:4,color:"#96a8c3"}}>Uses your saved Gemini/Groq key (Settings → AI drafting keys), or Workers AI if set up. The draft fills subject + body for review — nothing sends automatically.</small></div>{draftSaved&&<small style={{display:"block",marginTop:8,color:"#96a8c3"}}>{draftSaved}</small>}<footer><button className="primary" disabled={busy}>{busy?"Sending…":"Send message"}</button><small>Sender identity is taken from your verified domain setup.</small></footer><button type="button" onClick={discardDraft} style={{background:"none",border:0,color:"#f2a6a6",fontSize:11,padding:0}}>Discard draft</button></form></div>}</main>;
}
