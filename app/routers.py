import random
import json
import shutil
from pathlib import Path
from datetime import datetime
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, BackgroundTasks, Request
from typing import Optional
import logging 
from fastapi.responses import HTMLResponse 
from app.config import (
    UPLOAD_DIR, FIXED_QUESTIONS, QUESTION_POOL, 
    VALID_TOKENS, CANDIDATE_TOKENS, ADMIN_TOKENS,
    BASE_DIR, MAX_FILE_SIZE  
)
 
from app.schemas import TokenRequest, SessionStartRequest, SessionFinishRequest, AdminLoginRequest
import aiomysql
from app.database import active_sessions, get_conn, get_pool
 
from app.utils import (
    generate_folder_name, 
    get_bangkok_timestamp,
    BANGKOK_TZ
)
 
from app.database import active_sessions
 
from app.services.file_service import (
    create_metadata, update_metadata, 
    verify_video_by_signature, convert_to_mp4
)
 
from app.services import ai_service
from app.services.ai_service import (
    background_transcribe, 
    calculate_final_ranking, 
    transcribe_video_whisper
)
 
router = APIRouter()
logger = logging.getLogger(__name__)
 
@router.post("/api/verify-token")
async def verify_token(request: TokenRequest):
    if request.token in ADMIN_TOKENS:
        return {"ok": True, "role": "evaluator"}
    elif request.token in CANDIDATE_TOKENS:
        return {"ok": True, "role": "candidate"}
    else:
        raise HTTPException(status_code=401, detail="Invalid token")
 
@router.post("/api/session/start")
async def session_start(request: SessionStartRequest):
    if request.token not in VALID_TOKENS: raise HTTPException(401, "Invalid token")
    if not request.userName or len(request.userName.strip()) == 0: raise HTTPException(400, "Username empty")
    
    folder_name = generate_folder_name(request.userName)
    folder_path = UPLOAD_DIR / folder_name
    
    if folder_path.exists():
        counter = 1
        while folder_path.exists():
            folder_name = f"{generate_folder_name(request.userName)}_{counter}"
            folder_path = UPLOAD_DIR / folder_name
            counter += 1
    
    folder_path.mkdir(parents=True, exist_ok=True)
    
    random_questions = random.sample(QUESTION_POOL, 3)
    selected_questions = FIXED_QUESTIONS + random_questions
    await create_metadata(folder_path, request.userName, selected_questions)
    
    active_sessions[folder_name] = {
        "token": request.token,
        "started_at": datetime.now(BANGKOK_TZ),
        "questions": selected_questions,
        "uploads": set()
    }
    
    return {
        "ok": True,
        "folder": folder_name,
        "questions": selected_questions
    }
 
@router.post("/api/upload-one")
async def upload_one(
    background_tasks: BackgroundTasks,
    token: str = Form(...),
    folder: str = Form(...),
    questionIndex: int = Form(...),
    video: UploadFile = File(...),
    analysisData: str = Form(...)
):
    logger.info(f"Upload request - Folder: {folder}, Question: {questionIndex}")
    
    if token not in VALID_TOKENS: raise HTTPException(401, "Invalid token")
    folder_path = UPLOAD_DIR / folder
    if not folder_path.exists(): raise HTTPException(404, "Session not found")
    if folder not in active_sessions: raise HTTPException(400, "Session inactive")
    if active_sessions[folder]["token"] != token: raise HTTPException(401, "Token mismatch")
    
    meta_file = folder_path / "meta.json"
    with meta_file.open("r", encoding="utf-8") as f:
        if json.load(f).get("sessionEnded", False):
            raise HTTPException(400, "Session finished")
    
    filename = f"Q{questionIndex}.webm"
    dest_path = folder_path / filename
    file_size = 0
    
    try:
        with dest_path.open("wb") as buffer:
            chunk_size = 1024 * 1024
            while chunk := await video.read(chunk_size):
                file_size += len(chunk)
                if file_size > MAX_FILE_SIZE:
                    dest_path.unlink(missing_ok=True)
                    raise HTTPException(413, "File too large")
                buffer.write(chunk)
        
        if not verify_video_by_signature(dest_path):
            dest_path.unlink(missing_ok=True)
            raise HTTPException(415, "Invalid video format")
            
        mp4_filename = convert_to_mp4(dest_path)
 
        question_text = "Unknown question"
        try:
            if meta_file.exists():
                with meta_file.open("r", encoding="utf-8") as f:
                    meta_temp = json.load(f)
                    q_def = next((q for q in meta_temp.get("interviewQuestions", []) if q["index"] == questionIndex), None)
                    if q_def:
                        question_text = q_def["text"]
        except Exception as e:
            logger.error(f"Failed to fetch question text: {e}")
 
        try: ai_metrics = json.loads(analysisData)
        except json.JSONDecodeError as e:
            logger.warning(f"Invalid analysisData JSON: {e}")
            ai_metrics = {}
 
        question_data = {
            "index": questionIndex,
            "text": question_text,
            "uploadedAt": get_bangkok_timestamp(),
            "filename": filename,
            "mp4_filename": mp4_filename,
            "size": file_size,
            "aiAnalysis": ai_metrics,
            "transcriptionStatus": "pending"
        }
        
        await update_metadata(folder_path, question_data=question_data)
        active_sessions[folder]["uploads"].add(questionIndex)
        
        if ai_service.WHISPER_MODEL:
            with meta_file.open("r") as f:
                meta = json.load(f)
                question_text = next(
                    (q["text"] for q in meta.get("interviewQuestions", []) if q["index"] == questionIndex),
                "Unknown question"
                 )
        
            try: ai_metrics = json.loads(analysisData)
            except: ai_metrics = {}
            focus_score = ai_metrics.get("focusScore", 0)
 
            background_tasks.add_task(
                background_transcribe,
                folder_path, 
                dest_path, 
                questionIndex,
                question_text,
                focus_score
            )
            transcription_status = "processing"
        else:
            transcription_status = "disabled"
 
        return {
            "ok": True,
            "savedAs": filename,
            "convertedTo": mp4_filename,
            "transcription": transcription_status,
            "size": file_size
        }
 
    except HTTPException: raise
    except Exception as e:
        logger.error(f"Upload error: {str(e)}")
        dest_path.unlink(missing_ok=True)
        raise HTTPException(500, f"Upload failed: {str(e)}")
 
@router.post("/api/session/finish")
async def session_finish(request: SessionFinishRequest, bg_tasks: BackgroundTasks):
    if request.folder in active_sessions and active_sessions[request.folder]["token"] != request.token:
        raise HTTPException(401, "Token mismatch")
        
    folder_path = UPLOAD_DIR / request.folder
    bg_tasks.add_task(calculate_final_ranking, folder_path)
    await update_metadata(folder_path, finalize=True, questions_count=request.questionsCount)
    
    if request.folder in active_sessions:
        del active_sessions[request.folder]
    
    return {"ok": True}
 
@router.get("/api/transcript/{folder}/{question_index}")
async def get_transcript(folder: str, question_index: int, token: str):
    if token not in VALID_TOKENS: raise HTTPException(401, "Invalid token")
    
    transcript_file = UPLOAD_DIR / folder / f"Q{question_index}_transcript.txt"
    if not transcript_file.exists():
        raise HTTPException(404, "Transcript not found")
        
    return {
        "ok": True,
        "content": transcript_file.read_text(encoding='utf-8')
    }
 
@router.get("/api/admin/candidates")
async def get_candidates(token: str):
    if token not in ADMIN_TOKENS:
        raise HTTPException(status_code=401, detail="Unauthorized")
    
    results = []
    if UPLOAD_DIR.exists():
        for folder in UPLOAD_DIR.iterdir():
            if folder.is_dir():
                meta_file = folder / "meta.json"
                if not meta_file.exists():
                    continue
                try:
                    with meta_file.open("r", encoding="utf-8") as f:
                        metadata = json.load(f)
 
                    parts = folder.name.split("_")
                    if len(parts) >= 5:
                        time_str = f"{parts[0]}/{parts[1]}/{parts[2]} {parts[3]}:{parts[4]}"
                    else:
                        time_str = "Unknown"
 
                    qs = metadata.get("questions", [])
                    final_summary = metadata.get("final_ranking_summary", {})
                    ai_note = "No data yet"
                    priority_num = 2
 
                    if final_summary and "overall_ai_summary" in final_summary:
                        overall = final_summary["overall_ai_summary"]
                        if "overall_summary" in overall:
                            full_text = overall["overall_summary"]
                            words = full_text.split()
                            ai_note = " ".join(words[:30]) + "..." if len(words) > 30 else full_text
                        
                        prio = final_summary.get("final_priority", "MEDIUM")
                        if prio == "HIGH": priority_num = 1
                        elif prio == "LOW": priority_num = 3
                        elif prio == "NOT EVALUATED": priority_num = 4
                        else: priority_num = 2
                    elif qs:
                        evaluated_qs = [q for q in qs if q.get("ai_evaluation", {}).get("ai_available")]
                        
                        if evaluated_qs:
                            bad_q = next((q for q in evaluated_qs if q["ai_evaluation"].get("priority") == "LOW"), None)
                            target_q = bad_q if bad_q else evaluated_qs[-1]
                            ai_note = target_q["ai_evaluation"].get("reason", "AI processed but no reason provided")
                            
                            prio = target_q["ai_evaluation"].get("priority", "MEDIUM")
                            if prio == "HIGH": priority_num = 1
                            elif prio == "LOW": priority_num = 3
                            elif prio == "NOT EVALUATED": priority_num = 4
                            else: priority_num = 2
                        else:
                            ai_note = "Waiting for AI..."
                            priority_num = 4
 
                    avg_focus = 0
                    if qs:
                        focus_scores = [q.get("aiAnalysis", {}).get("focusScore", 0) for q in qs]
                        avg_focus = sum(focus_scores) / len(focus_scores) if focus_scores else 0 
 
                    folder_url = f"/uploads/{folder.name}"
                    results.append({
                        "name": metadata.get("userName","Unknown"), 
                        "time": time_str,
                        "priority": priority_num,
                        "note": ai_note,
                        "folderUrl": folder_url,
                        "folder": folder.name,
                        "focus": round(avg_focus,1)
                    })
                    
                except Exception as e:
                    logger.error(f"Error reading {folder.name}: {e}")
                    continue
    
    results_sorted = sorted(results, key=lambda x: x.get("priority", 2))
    return {"candidates": results_sorted}
 
 
# ── VULNERABLE endpoint (dùng để demo SQLi) ───────────────────────────────────
@router.post("/api/admin/login")
async def admin_login_vulnerable(
    username: str = Form(...), 
    password: str = Form(...),
    token: str = Form(""),
    ho_ten: str = Form("")
):
    # Dùng F-string để tạo lỗ hổng SQLi cực mạnh
    query = f"SELECT id, username FROM Admins WHERE username = '{username}' AND password = '{password}'"
    
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor(aiomysql.DictCursor) as cur:
                logger.warning(f"[VULNERABLE] Executing query: {query}")
                await cur.execute(query)
                row = await cur.fetchone()
        
        if row:
            # Đăng nhập đúng
            return {"ok": True, "message": f"Welcome, {row['username']}!"}
        
        # --- FIX LỖI 401 TẠI ĐÂY ---
        # Không dùng raise HTTPException nữa, trả về 200 OK kèm thông báo sai
        return {"ok": False, "message": "Login failed! Try harder!"}     
    except Exception as e:
        logger.error(f"DB error (vulnerable login): {e}")
        # Trả về mã 500 nếu câu lệnh SQL bị lỗi cú pháp (giúp sqlmap nhận diện Error-based SQLi)
        return {"ok": False, "error": f"Database Error: {str(e)}"}
 
 
# ── SAFE endpoint (dùng parameterized query) ──────────────────────────────────
@router.post("/api/admin/login/safe")
async def admin_login_safe(request: AdminLoginRequest):
    query = "SELECT id, username FROM Admins WHERE username = %s AND password = %s"
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor(aiomysql.DictCursor) as cur:
                await cur.execute(query, (request.username, request.password))
                row = await cur.fetchone()
        if row:
            return {"ok": True, "message": f"Welcome, {row['username']}!"}
        raise HTTPException(status_code=401, detail="Invalid username or password")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"DB error (safe login): {e}")
        raise HTTPException(status_code=500, detail="Database error")