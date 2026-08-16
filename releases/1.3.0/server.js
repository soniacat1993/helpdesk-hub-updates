require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const { Pool } = require("pg");
const { randomUUID, createHash } = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Document, HeadingLevel, Packer, Paragraph, TextRun } = require("docx");

const root = __dirname;
const port = Number(process.env.PORT || 3847);
const attachmentsDir = path.resolve(root, process.env.ATTACHMENTS_DIR || "./data/attachments");
const updateManifestUrl = "https://raw.githubusercontent.com/soniacat1993/helpdesk-hub-updates/main/latest.json";
const allowedUpdateFiles = new Set(["server.js","public/app.js","public/index.html","public/style.css","database/schema.sql","Apply-AutoUpdate.ps1","app-version.json"]);
const versionFile = path.join(root,"app-version.json");
const currentVersion = (()=>{try{return JSON.parse(fs.readFileSync(versionFile,"utf8")).version||"1.2.0"}catch{return "1.2.0"}})();
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing. Run Setup-HelpdeskHub.ps1 first.");
fs.mkdirSync(attachmentsDir, { recursive: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });
const app = express();
const pidFile = path.join(root, "data", "app.pid");
fs.writeFileSync(pidFile, String(process.pid));
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(root, "public"), { etag: true, maxAge: 0 }));

const asyncRoute = fn => (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const noteFields = "id,title,body,product,product_subcategory,source,category,channel,sendings_via,tags,ticket,created_at AS date,updated_at";
const incidentFields = "id,title,severity,product,status,impact,timeline,cause,resolution,created_at AS date,updated_at";
const compareVersions=(a,b)=>{const aa=String(a).split(".").map(Number),bb=String(b).split(".").map(Number);for(let i=0;i<3;i++){if((aa[i]||0)!==(bb[i]||0))return(aa[i]||0)-(bb[i]||0)}return 0};
async function latestManifest(){const response=await fetch(updateManifestUrl,{headers:{"User-Agent":"Helpdesk-Knowledge-Hub"},signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error(`Update server returned ${response.status}.`);const manifest=await response.json();if(!/^\d+\.\d+\.\d+$/.test(manifest.version)||!Array.isArray(manifest.files))throw new Error("The update manifest is invalid.");return manifest}

app.get("/api/health", asyncRoute(async(_req,res)=>{ await pool.query("SELECT 1"); res.json({ok:true,storage:"PostgreSQL",localOnly:true}); }));
app.get("/api/update/check",asyncRoute(async(_req,res)=>{const manifest=await latestManifest();res.json({currentVersion,latestVersion:manifest.version,available:compareVersions(manifest.version,currentVersion)>0,notes:manifest.notes||""})}));
app.post("/api/update/install",asyncRoute(async(req,res)=>{
  if(req.get("X-Helpdesk-Update")!=="confirm")return res.status(403).json({error:"Update confirmation is missing."});
  const manifest=await latestManifest();
  if(compareVersions(manifest.version,currentVersion)<=0)return res.json({ok:true,restarting:false,message:"The app is already up to date."});
  const expectedPrefix=`/soniacat1993/helpdesk-hub-updates/main/releases/${manifest.version}/`;
  const staging=path.join(root,"data","update-staging",manifest.version);fs.rmSync(staging,{recursive:true,force:true});fs.mkdirSync(staging,{recursive:true});
  let totalBytes=0;const plan=[];
  for(const item of manifest.files){
    if(!allowedUpdateFiles.has(item.path)||!/^[a-f0-9]{64}$/.test(item.sha256))throw new Error("The update contains an unapproved file.");
    const remote=new URL(item.url);if(remote.protocol!=="https:"||remote.hostname!=="raw.githubusercontent.com"||remote.pathname!==expectedPrefix+item.path)throw new Error("The update source is not trusted.");
    const response=await fetch(remote,{headers:{"User-Agent":"Helpdesk-Knowledge-Hub"},signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error(`Could not download ${item.path}.`);
    const bytes=Buffer.from(await response.arrayBuffer());totalBytes+=bytes.length;if(bytes.length>2*1024*1024||totalBytes>10*1024*1024)throw new Error("The update is unexpectedly large.");
    if(createHash("sha256").update(bytes).digest("hex")!==item.sha256)throw new Error(`Security check failed for ${item.path}.`);
    const stagedPath=path.join(staging,item.path);fs.mkdirSync(path.dirname(stagedPath),{recursive:true});fs.writeFileSync(stagedPath,bytes);plan.push({path:item.path});
  }
  fs.writeFileSync(path.join(staging,"update-plan.json"),JSON.stringify({version:manifest.version,files:plan},null,2));
  const helper=path.join(root,"Apply-AutoUpdate.ps1");if(!fs.existsSync(helper))throw new Error("The automatic update helper is missing.");
  const child=spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",helper,"-AppRoot",root,"-StagingDir",staging,"-ParentPid",String(process.pid)],{detached:true,stdio:"ignore",windowsHide:true});child.unref();
  res.json({ok:true,restarting:true,version:manifest.version});setTimeout(()=>server.close(()=>process.exit(0)),800);
}));
app.get("/api/notes", asyncRoute(async(req,res)=>{
  const q=String(req.query.q||"").slice(0,200),product=String(req.query.product||""),source=String(req.query.source||""),subcategory=String(req.query.subcategory||""),channel=String(req.query.channel||""),sendingsVia=String(req.query.sendings_via||"");
  const {rows}=await pool.query(`SELECT ${noteFields}, COALESCE((SELECT json_agg(json_build_object('id',a.id,'name',a.original_name,'type',a.mime_type,'size',a.size_bytes)) FROM attachments a WHERE a.note_id=notes.id),'[]') AS files FROM notes WHERE deleted_at IS NULL AND ($1='' OR title ILIKE '%'||$1||'%' OR body ILIKE '%'||$1||'%' OR ticket ILIKE '%'||$1||'%' OR product_subcategory ILIKE '%'||$1||'%' OR channel ILIKE '%'||$1||'%' OR sendings_via ILIKE '%'||$1||'%' OR $1=ANY(tags)) AND ($2='' OR product=$2) AND ($3='' OR source=$3) AND ($4='' OR product_subcategory=$4) AND ($5='' OR channel=$5) AND ($6='' OR sendings_via=$6) ORDER BY updated_at DESC`,[q,product,source,subcategory,channel,sendingsVia]);res.json(rows);
}));
app.post("/api/notes", asyncRoute(async(req,res)=>{
  const n=req.body,id=randomUUID(); if(!n.title?.trim()||!n.body?.trim())return res.status(400).json({error:"Title and note are required."});
  const subcategory=n.product==="Other WebSMS Platform"?(n.product_subcategory||""):"",ticket=n.source==="Ticket"?(n.ticket||""):"";
  const {rows}=await pool.query(`INSERT INTO notes(id,title,body,product,product_subcategory,source,category,channel,sendings_via,tags,ticket) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${noteFields}`,[id,n.title.trim(),n.body.trim(),n.product,subcategory,n.source,n.category,n.channel||"SMS",n.sendings_via||"Both",n.tags||[],ticket]);res.status(201).json({...rows[0],files:[]});
}));
app.put("/api/notes/:id", asyncRoute(async(req,res)=>{
  const n=req.body,subcategory=n.product==="Other WebSMS Platform"?(n.product_subcategory||""):"",ticket=n.source==="Ticket"?(n.ticket||""):"",client=await pool.connect();try{await client.query("BEGIN");const old=await client.query("SELECT * FROM notes WHERE id=$1 AND deleted_at IS NULL",[req.params.id]);if(!old.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Note not found."})}const o=old.rows[0];await client.query("INSERT INTO note_versions(note_id,title,body,product,product_subcategory,source,category,channel,sendings_via,tags,ticket) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[o.id,o.title,o.body,o.product,o.product_subcategory||"",o.source,o.category,o.channel||"",o.sendings_via||"",o.tags,o.ticket]);const {rows}=await client.query(`UPDATE notes SET title=$2,body=$3,product=$4,product_subcategory=$5,source=$6,category=$7,channel=$8,sendings_via=$9,tags=$10,ticket=$11,updated_at=NOW() WHERE id=$1 RETURNING ${noteFields}`,[req.params.id,n.title.trim(),n.body.trim(),n.product,subcategory,n.source,n.category,n.channel||"SMS",n.sendings_via||"Both",n.tags||[],ticket]);await client.query("COMMIT");res.json(rows[0])}catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}));
app.delete("/api/notes/:id", asyncRoute(async(req,res)=>{await pool.query("UPDATE notes SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1",[req.params.id]);res.status(204).end()}));
app.get("/api/trash", asyncRoute(async(_req,res)=>{const {rows}=await pool.query(`SELECT ${noteFields},deleted_at FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`);res.json(rows)}));
app.post("/api/trash/:id/restore", asyncRoute(async(req,res)=>{await pool.query("UPDATE notes SET deleted_at=NULL,updated_at=NOW() WHERE id=$1",[req.params.id]);res.status(204).end()}));

app.get("/api/incidents", asyncRoute(async(_req,res)=>{const {rows}=await pool.query(`SELECT ${incidentFields} FROM incidents WHERE deleted_at IS NULL ORDER BY updated_at DESC`);res.json(rows)}));
app.post("/api/incidents", asyncRoute(async(req,res)=>{const i=req.body,id=randomUUID();if(!i.title?.trim())return res.status(400).json({error:"Title is required."});const {rows}=await pool.query(`INSERT INTO incidents(id,title,severity,product,status,impact,timeline,cause,resolution) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${incidentFields}`,[id,i.title.trim(),i.severity,i.product,i.status,i.impact||"",i.timeline||"",i.cause||"",i.resolution||""]);res.status(201).json(rows[0])}));
app.put("/api/incidents/:id", asyncRoute(async(req,res)=>{const i=req.body;const {rows}=await pool.query(`UPDATE incidents SET title=$2,severity=$3,product=$4,status=$5,impact=$6,timeline=$7,cause=$8,resolution=$9,updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING ${incidentFields}`,[req.params.id,i.title.trim(),i.severity,i.product,i.status,i.impact||"",i.timeline||"",i.cause||"",i.resolution||""]);if(!rows.length)return res.status(404).json({error:"Incident not found."});res.json(rows[0])}));
app.delete("/api/incidents/:id", asyncRoute(async(req,res)=>{await pool.query("UPDATE incidents SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1",[req.params.id]);res.status(204).end()}));

const storage=multer.diskStorage({destination:attachmentsDir,filename:(_req,file,cb)=>cb(null,`${randomUUID()}${path.extname(file.originalname).slice(0,12)}`)});
const upload=multer({storage,limits:{fileSize:10*1024*1024,files:10}});
app.post("/api/notes/:id/attachments",upload.array("files",10),asyncRoute(async(req,res)=>{const client=await pool.connect();try{await client.query("BEGIN");const items=[];for(const f of req.files){const id=randomUUID();await client.query("INSERT INTO attachments(id,note_id,original_name,stored_name,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6)",[id,req.params.id,f.originalname,f.filename,f.mimetype,f.size]);items.push({id,name:f.originalname,type:f.mimetype,size:f.size})}await client.query("COMMIT");res.status(201).json(items)}catch(e){await client.query("ROLLBACK");for(const f of req.files||[])fs.rmSync(f.path,{force:true});throw e}finally{client.release()}}));
app.get("/api/attachments/:id",asyncRoute(async(req,res)=>{const {rows}=await pool.query("SELECT * FROM attachments WHERE id=$1",[req.params.id]);if(!rows.length)return res.status(404).end();const a=rows[0];res.download(path.join(attachmentsDir,a.stored_name),a.original_name)}));

app.post("/api/export/word",asyncRoute(async(req,res)=>{const ids=Array.isArray(req.body.ids)?req.body.ids:[];const {rows}=await pool.query(`SELECT ${noteFields} FROM notes WHERE deleted_at IS NULL AND ($1::uuid[]='{}' OR id=ANY($1::uuid[])) ORDER BY updated_at DESC`,[ids]);const children=[new Paragraph({text:"Helpdesk Knowledge Notes",heading:HeadingLevel.TITLE}),new Paragraph({text:`Exported ${new Date().toLocaleDateString("en-GB")}`}),...rows.flatMap(n=>[new Paragraph({text:n.title,heading:HeadingLevel.HEADING_1}),new Paragraph({children:[new TextRun({text:`${n.product}${n.product_subcategory?` / ${n.product_subcategory}`:""} • ${n.category} • Source: ${n.source}`,bold:true,color:"3557D4"})]}),new Paragraph({text:`Channel: ${n.channel||"—"} • Sending via: ${n.sendings_via||"—"}`}),...(n.ticket?[new Paragraph({text:`Ticket: ${n.ticket}`})]:[]),new Paragraph({text:n.body}),...(n.tags.length?[new Paragraph({text:`Tags: ${n.tags.join(", ")}`})]:[]),new Paragraph("")])];const buffer=await Packer.toBuffer(new Document({sections:[{children}]}));res.set({"Content-Type":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","Content-Disposition":`attachment; filename="helpdesk-notes-${new Date().toISOString().slice(0,10)}.docx"`});res.send(buffer)}));
app.get("/api/export/json",asyncRoute(async(_req,res)=>{const [notes,incidents,attachments,versions]=await Promise.all([pool.query("SELECT * FROM notes"),pool.query("SELECT * FROM incidents"),pool.query("SELECT id,note_id,original_name,mime_type,size_bytes,created_at FROM attachments"),pool.query("SELECT * FROM note_versions")]);res.set("Content-Disposition",`attachment; filename="helpdesk-backup-${new Date().toISOString().slice(0,10)}.json"`);res.json({exportedAt:new Date().toISOString(),notes:notes.rows,incidents:incidents.rows,attachments:attachments.rows,noteVersions:versions.rows})}));

app.use((err,_req,res,_next)=>{console.error(err);res.status(err.code==="LIMIT_FILE_SIZE"?413:500).json({error:err.code==="LIMIT_FILE_SIZE"?"File exceeds 10 MB.":"Something went wrong. Your existing data was not changed."})});
let server;
async function migrate(){
  for(const sql of [
    "ALTER TABLE notes ADD COLUMN IF NOT EXISTS product_subcategory TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE notes ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE notes ADD COLUMN IF NOT EXISTS sendings_via TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE note_versions ADD COLUMN IF NOT EXISTS product_subcategory TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE note_versions ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE note_versions ADD COLUMN IF NOT EXISTS sendings_via TEXT NOT NULL DEFAULT ''"
  ]) await pool.query(sql);
}
migrate().then(()=>{server=app.listen(port,"127.0.0.1",()=>console.log(`Helpdesk Hub is ready at http://127.0.0.1:${port}`))}).catch(err=>{console.error("Database update failed:",err.message);fs.rmSync(pidFile,{force:true});process.exit(1)});
async function stop(){if(server)server.close();await pool.end();fs.rmSync(pidFile,{force:true});process.exit(0)}
process.on("SIGINT",stop);process.on("SIGTERM",stop);process.on("exit",()=>fs.rmSync(pidFile,{force:true}));
