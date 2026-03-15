async function verifyAndStart() {
    token = document.getElementById('token').value.trim();
    userName = document.getElementById('userName').value.trim();
    
    if (!token) {
        alert('Please enter token');
        return;
    }

    const statusEl = document.getElementById('token-status');
    statusEl.textContent = 'Verifying......';

    try {
        const vRes = await fetch(`${API_BASE}/api/verify-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });

        if (!vRes.ok) throw new Error('Invalid token');
        const authData = await vRes.json();

        // ---TH1: Là Admin---
        if (authData.role === 'evaluator') {
            statusEl.textContent = 'Token OK — enter admin credentials below';
            document.getElementById('admin-credentials').style.display = 'block';
            return;
        }

        //---TH2: Là ứng viên ---
        if (!userName) { 
            alert('Please enter Full Name!'); 
            statusEl.textContent = '';
            return;
        }

        const sRes = await fetch(`${API_BASE}/api/session/start`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ token, userName })
        });
    
        if (!sRes.ok) throw new Error('Session creation failed');
        const data = await sRes.json();
    
        // Vào màn hình phỏng vấn
        folder = data.folder;
        QUESTIONS = data.questions;
    
        document.getElementById('step-token').style.display = 'none';
        document.getElementById('step-permission').style.display = 'block';

    } catch (error) {
        statusEl.textContent = 'Error: ' + error.message;
        statusEl.className = 'status-text status-error';
    }
}

async function loadDashboard() {
    // Ẩn màn hình login, hiện dashboard
    document.getElementById('step-token').style.display = 'none';
    document.getElementById('step-dashboard').style.display = 'block';

    const tbody = document.getElementById('candidate-list');
    tbody.innerHTML = '<tr><td colspan="5">Loading data...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/api/admin/candidates?token=${token}`);
        const data = await res.json();
    
        tbody.innerHTML = ''; // Xóa loading
    
        data.candidates.forEach(c => {
            let priorityColor = 'green';
            if (c.priority === 2) priorityColor = 'orange';
            if (c.priority === 3) priorityColor = 'red';
            if (c.priority === 4) priorityColor = 'gray';

            tbody.innerHTML +=`
                <tr>
                    <td><strong>${c.name}</strong></td>
                    <td>${c.time}</td>
                    <td style="color:${priorityColor}; font-weight:bold;">
                        ${c.priority === 1 ? '⭐ High' :
                          c.priority === 2 ? '🔶 Medium' :
                          c.priority === 3 ? '❌ Low': 
                          c.priority === 4 ? '❔ Not Evaluated': 'NOT EVALUATED'}
                    </td>
                    <td>${c.note}</td>
                    <td>
                        <button onclick="viewCandidate('${c.folder}')" style="padding: 5px 10px; font-size: 14px; background: #667eea; color: white; border: none; border-radius: 4px; cursor: pointer;">
                            📁 Videos
                        </button>
                    </td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5">Error loading data</td></tr>';
    }
}
async function requestPermissions() {
    const statusEl = document.getElementById('permission-status');
    statusEl.textContent = 'Requesting permissions...';
    statusEl.className = 'status-text status-info';

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
            width: { ideal: 1280, max: 1280 },
            height: { ideal: 720, max: 720 },
            frameRate: { ideal: 30, max: 30 }
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        document.getElementById('mic-visualizer').style.display = 'block';

        // 2. Kết nối luồng âm thanh để lấy độ to
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        src.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        const mask = document.getElementById('mic-fill-mask');

        // 3. Vòng lặp cập nhật hình ảnh liên tục
        function loop() {
            requestAnimationFrame(loop);
            analyser.getByteFrequencyData(data);
            // Lấy giá trị lớn nhất (độ to) gán vào chiều cao
            // Chia 2.55 để đổi từ 0-255 sang 0-100%
            mask.style.height = (Math.max(...data) / 2.55) + '%';
        }
        loop();
        document.getElementById('preview').srcObject = stream;
        statusEl.textContent = 'Permissions granted!';
        statusEl.className = 'status-text status-success';

        await initAI();

        setTimeout(() => {
            document.getElementById('step-permission').style.display = 'none';
            document.getElementById('step-interview').style.display = 'block';
            document.getElementById('folder-name').textContent = folder;
            loadQuestion(0);
        }, 1500);

    } catch (error) {
        statusEl.textContent = 'Error: ' + error.message;
        statusEl.className = 'status-text status-error';
        alert('Cannot access camera/microphone. Please check browser permissions.');
    }
}
function startAutoCountdown() {
    const btnStart = document.getElementById('btn-start-record');
    const statusEl = document.getElementById('recording-status');

    let prepTime = 15;
    statusEl.textContent = 'Preparing...';
    btnStart.textContent = `Start (${prepTime}s)`;

    // Đảm bảo không có interval nào đang chạy chồng chéo
    if (countdownInterval) clearInterval(countdownInterval);

    countdownInterval = setInterval(() => {
        prepTime--;
        btnStart.textContent = `Start (${prepTime}s)`;

        if (prepTime <= 0) {
            // Hết giờ chuẩn bị -> Tự động quay
            clearInterval(countdownInterval);
            startRealRecording();
        }
    }, 1000);
}
function loadQuestion(index) {
    currentQuestionIndex = index;
    retriesUsed = 0;
    retryCountForCurrentQuestion = 0; // ← RESET đếm retry
    document.getElementById('review-section').style.display = 'none'; // ← ẨN review
    document.getElementById('current-question-num').textContent = index + 1;
    document.getElementById('current-question-text').textContent = QUESTIONS[index];
    document.getElementById('recording-status').textContent = 'Ready';
    document.getElementById('upload-status').textContent = '';
    document.getElementById('btn-retry-upload').style.display = 'none';
    // Reset đồng hồ
    document.getElementById('timer-display').textContent = "03:00";
    document.getElementById('timer-display').style.color = "#333";
    const btnStart = document.getElementById('btn-start-record');

    btnStart.disabled = false; 
    btnStart.textContent = "Start";
    // Reset nút bấm
    document.getElementById('btn-stop-record').disabled = true;
    document.getElementById('btn-next').disabled = true;
    
    const btnNext = document.getElementById('btn-next');
    if (index >= QUESTIONS.length - 1) {
        btnNext.textContent = 'Finish Interview';
        btnNext.style.background = 'linear-gradient(135deg, #28a745 0%, #20c997 100%)';
    } else {
        btnNext.textContent = 'Next Question';
        btnNext.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(QUESTIONS[index]);
    utterance.lang = 'en-US'; // Hoặc 'en-US' nếu câu hỏi tiếng Anh
    utterance.rate = 0.9;
    
    currentUtterance = utterance;

    utterance.onend = () => {
        startAutoCountdown();
    };

    speechSynthesis.speak(utterance);
}
function startRealRecording() {
    const btnStart = document.getElementById('btn-start-record');
    btnStart.textContent = 'Recording...'; 
    btnStart.disabled = true;

    document.getElementById('btn-stop-record').disabled = false; // Mở nút Stop
    document.getElementById('recording-status').textContent = 'Recording...';

    recordedChunks = [];
    violationStartTime = null;
    
    mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp8,opus'
    });

    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };

    mediaRecorder.onstop = () => {
        showVideoReview();
    };

    aiAnalysis = {
        totalFrames: 0,
        lookingAwayFrames: 0,
        multipleFacesFrames: 0,
        noFaceFrames: 0,
        warnings: []
    };
    isAiRunning = true;
    
    mediaRecorder.start();

    // Logic đồng hồ đếm nguoc
    let timeLeft = TIME_LIMIT_SEC;
    const timerEl = document.getElementById('timer-display');
    
    if (timerInterval) clearInterval(timerInterval);
    
    timerInterval = setInterval(() => {
        timeLeft--;
        
        // Format phút:giây
        const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
        const s = (timeLeft % 60).toString().padStart(2, '0');
        timerEl.textContent = `${m}:${s}`;
        
        // Cảnh báo đỏ khi còn 30s
        if (timeLeft < 30) timerEl.style.color = "red";
        else timerEl.style.color = "#333";

        // Hết giờ -> Tự động dừng
        if (timeLeft <= 0) {
            stopRecording();
        }
    }, 1000);
}
function startRecording() {
    if (currentUtterance) {
        currentUtterance.onend = null; // Hủy sự kiện để nó không tự gọi đếm ngược nữa
    }
    speechSynthesis.cancel(); 

    // 2. Dừng đếm ngược nếu đang chạy (biến countdownInterval từ hàm startAutoCountdown)
    if (typeof countdownInterval !== 'undefined' && countdownInterval) {
        clearInterval(countdownInterval);
    }

    // 3. Dừng bộ đếm cũ (nếu code cũ bạn còn dùng biến này)
    if (typeof prepInterval !== 'undefined' && prepInterval) {
        clearInterval(prepInterval);
    }

    // 4. Vào quay chính thức ngay lập tức
    startRealRecording();
}
function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        isAiRunning = false;
        violationStartTime = null;

        // Dung đồng hồ
        if (timerInterval) clearInterval(timerInterval);

        document.getElementById('recording-status').textContent = 'Stopped';
        document.getElementById('btn-stop-record').disabled = true;

        // Hiện nút retry
        // Nếu chua dùng luot entry nào thì hiện nút
    }
}
function showVideoReview() {
    pendingVideoBlob = new Blob(recordedChunks, { type: 'video/webm' });
    
    // Kiểm tra kích thước
    if (pendingVideoBlob.size > MAX_FILE_SIZE) {
        alert(`❌ Video too large (${(pendingVideoBlob.size / 1024 / 1024).toFixed(2)}MB). Max 50MB.`);
        resetForRetry();
        return;
    }
    
    // Tạo URL để preview
    const videoUrl = URL.createObjectURL(pendingVideoBlob);
    const reviewPlayer = document.getElementById('review-player');
    reviewPlayer.src = videoUrl;

    const btnCancel = document.querySelector('#review-section button[onclick="cancelReview()"]');
    if (retryCountForCurrentQuestion >= MAX_RETRIES_PER_QUESTION) {
        btnCancel.style.display = 'none'; // Ẩn nút Cancel/Retry
    } else {
        btnCancel.style.display = 'inline-block'; // Hiện nút Cancel/Retry
    }
    
    // Hiển thị phần review
    document.getElementById('review-section').style.display = 'block';
    document.getElementById('recording-status').textContent = '⏸️ Review and Decide';
}

// HÀM MỚI: Xác nhận upload
function confirmVideo() {
    if (!pendingVideoBlob) {
        alert('No video found!');
        return;
    }
    
    // Ẩn review section
    document.getElementById('review-section').style.display = 'none';
    
    // Bật nút Next để upload
    document.getElementById('btn-next').disabled = false;
    document.getElementById('recording-status').textContent = '✅ Video ready - Click "Next Question" to upload';
}

// HÀM MỚI: Hủy và cho phép thu lại
function cancelReview() {
    if (retryCountForCurrentQuestion >= MAX_RETRIES_PER_QUESTION) {
    alert('❌ You have used your retry limit for this question!\n\nPlease choose "✅ Accept" to continue.');
    return; // CHẶN không cho retry thêm
    }

    // Confirm trước khi retry
    if (!confirm('⚠️ You can only retry ONCE for this question.\n\nAre you sure?')) {
        return; // User không muốn retry
    }
    
    // ✅ Tăng biến đếm
    retryCountForCurrentQuestion++;

    // Xóa video preview
    const reviewPlayer = document.getElementById('review-player');
    URL.revokeObjectURL(reviewPlayer.src);
    reviewPlayer.src = '';
    
    // Ẩn review section
    document.getElementById('review-section').style.display = 'none';
    
    // Reset để thu lại
    resetForRetry();
}

// HÀM MỚI: Reset để thu lại
function resetForRetry() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    mediaRecorder = null; // ✅ QUAN TRỌNG: Set null để giải phóng
    
    pendingVideoBlob = null;
    recordedChunks = [];
    
    // ✅ THÊM: Reset AI analysis state
    aiAnalysis = {
        totalFrames: 0,
        lookingAwayFrames: 0,
        multipleFacesFrames: 0,
        noFaceFrames: 0,
        warnings: []
    };
    isAiRunning = false;
    violationStartTime = null;
    
    document.getElementById('recording-status').textContent = '🔄 Ready to retry';
    document.getElementById('timer-display').textContent = "03:00";
    document.getElementById('timer-display').style.color = "#333";
    document.getElementById('ai-warning').textContent = ""; // ✅ THÊM: Xóa cảnh báo AI
    
    const btnStart = document.getElementById('btn-start-record');
    btnStart.disabled = false; 
    btnStart.textContent = "Start Recording";
    
    document.getElementById('btn-stop-record').disabled = true;
    document.getElementById('btn-next').disabled = true;
}
async function uploadVideo(isRetry = false) {
    if (!isRetry) {
        uploadRetryCount = 0;
    }

    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    
    if (blob.size > MAX_FILE_SIZE) {
        const statusEl = document.getElementById('upload-status');
        statusEl.textContent = `Error: File too large (${(blob.size / 1024 / 1024).toFixed(2)}MB). Max 50MB`;
        statusEl.className = 'status-text status-error';
        document.getElementById('btn-retry').style.display = 'inline-block';
        return;
    }

    const focusScore = aiAnalysis.totalFrames > 0 
        ? Math.round(((aiAnalysis.totalFrames - aiAnalysis.lookingAwayFrames) / aiAnalysis.totalFrames) * 100) 
        : 0;

    const analysisJson = JSON.stringify({
        focusScore: focusScore,
        warnings: [...new Set(aiAnalysis.warnings)]
    });

    const formData = new FormData();
    formData.append('token', token);
    formData.append('folder', folder);
    formData.append('questionIndex', currentQuestionIndex + 1);
    formData.append('video', blob, `Q${currentQuestionIndex + 1}.webm`);
    formData.append('analysisData', analysisJson);

    const statusEl = document.getElementById('upload-status');
    statusEl.textContent = 'Uploading....';
    statusEl.className = 'status-text status-info';

    try {
        const response = await fetch(`${API_BASE}/api/upload-one`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Upload failed');
        }

        const data = await response.json();
        
        statusEl.textContent = `Upload successful: ${data.savedAs} (${(blob.size / 1024 / 1024).toFixed(2)}MB)`;
        statusEl.className = 'status-text status-success';
        
        document.getElementById('btn-retry-upload').style.display = 'none';
        document.getElementById('btn-next').disabled = false;
        uploadRetryCount = 0;

    } catch (error) {
        uploadRetryCount++;
        
        const waitSeconds = Math.pow(2, uploadRetryCount); // 2^1=2s, 2^2=4s, 2^3=8s
        nextRetryTime = Date.now() + (waitSeconds * 1000);
        statusEl.textContent = `❌ Upload failed. Retry in ${waitSeconds}s...`;
        statusEl.className = 'status-text status-error';
    
        const retryBtn = document.getElementById('btn-retry-upload');
        retryBtn.style.display = 'inline-block';
        retryBtn.disabled = true; // ← DISABLE NÚT

        const countdownInterval = setInterval(() => {
            const remaining = Math.ceil((nextRetryTime - Date.now()) / 1000);
    
            if (remaining <= 0) {
                clearInterval(countdownInterval);

                if (uploadRetryCount >= MAX_RETRIES) {
                    retryBtn.textContent = '❌ Max retries';
                    retryBtn.disabled = true;
                    statusEl.textContent = '❌ Contact support';
                } else {
                    retryBtn.disabled = false;
                    retryBtn.textContent = '🔄 Retry Upload';
                }
            } else {
                retryBtn.textContent = `⏳ Retry in ${remaining}s`;
            }
        }, 1000);
    }
}
async function nextQuestion() {
    if (pendingVideoBlob) {
        // Vô hiệu hóa nút để tránh spam
        document.getElementById('btn-next').disabled = true;
        document.getElementById('recording-status').textContent = '📤 Uploading...';
        
        // Upload video
        await uploadVideo();
        
        // Sau khi upload xong mới chuyển câu
        const statusEl = document.getElementById('upload-status');
        if (statusEl.textContent.includes('Upload successful')) {
            pendingVideoBlob = null;
            
            if (currentQuestionIndex >= QUESTIONS.length - 1) {
                await finishInterview();
            } else {
                loadQuestion(currentQuestionIndex + 1);
            }
        }
    } else {
        alert('No video to upload!');
    }
}

async function finishInterview() {
    const shouldConfirm = !pendingVideoBlob || currentQuestionIndex < QUESTIONS.length - 1;
    
    if (shouldConfirm && !confirm('Are you sure you want to finish the interview?')) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/session/finish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: token,
                folder: folder,
                questionsCount: currentQuestionIndex + 1
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to finish session');
        }

        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }

        document.getElementById('step-interview').style.display = 'none';
        document.getElementById('step-complete').style.display = 'block';
        document.getElementById('final-folder-name').textContent = folder;
        document.getElementById('total-questions').textContent = currentQuestionIndex + 1;

    } catch (error) {
        alert('Error: ' + error.message);
    }
}

window.addEventListener('beforeunload', (e) => {
    if (stream && document.getElementById('step-interview').style.display === 'block') {
        e.preventDefault();
        e.returnValue = 'Are you sure? Data might be lost.';
    }
});
async function viewCandidate(folderName) {
    const dashboard = document.getElementById('step-dashboard');
    const reviewPage = document.getElementById('step-admin-review');
    const container = document.getElementById('review-videos-container');
    const nameLabel = document.getElementById('review-candidate-name');

    // Chuyển màn hình & hiện loading
    dashboard.style.display = 'none';
    reviewPage.style.display = 'block';
    container.innerHTML = '<p style="text-align:center; margin-top:50px;">⏳ Loading videos...</p>';
    nameLabel.textContent = ''; // Reset tên

    try {
        // 1. Fetch dữ liệu
        const res = await fetch(`/uploads/${folderName}/meta.json`);
        if (!res.ok) throw new Error("Data file not found (meta.json)");
        const meta = await res.json();

        // 2. Hiện tên
        nameLabel.textContent = `Candidate: ${meta.userName}`;

        // 3. Render danh sách video
        container.innerHTML = ''; // Xóa loading
        const questions = meta.questions.sort((a, b) => a.index - b.index);

        if (questions.length === 0) {
            container.innerHTML = '<p style="text-align:center;">No videos uploaded.</p>';
            return;
        }

        questions.forEach(q => {
            // Lấy đường dẫn video (ưu tiên mp4)
            const videoFile = q.mp4_filename || q.filename;
            const videoUrl = `/uploads/${folderName}/${videoFile}`;
    
            const aiData = q.ai_evaluation || {};
            const metrics = q.metrics || {};

            // Tạo badge màu cho Priority
            let priorityBadge = '<span class="badge bg-orange">TB</span>';
            if(aiData.priority === 'HIGH') priorityBadge = '<span class="badge bg-green">High</span>';
            if(aiData.priority === 'LOW') priorityBadge = '<span class="badge bg-red">Low</span>';
            if(aiData.priority === 'NOT EVALUATED') priorityBadge = '<span class="badge bg-gray">Not Evaluated</span>';
            // Giao diện Card Video tối giản
            const html = `
                <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 30px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                    <div style="background: #667eea; padding: 12px 20px; color: white; font-weight: bold; font-size: 1.1em;">
                        Video Câu ${q.index}
                    </div>

                    <div style="display:flex; flex-wrap:wrap;">
                        <div style="flex: 2; min-width: 450px; background: #000;">
                            <video controls style="width: 100%; height: 100%; display:block; max-height: 500px;">
                                <source src="${videoUrl}" type="video/mp4">
                                <source src="${videoUrl}" type="video/webm">
                                Trình duyệt không hỗ trợ video.
                            </video>
                        </div>
                
                        <div style="flex: 1; min-width: 300px; padding: 25px; background: #fff; display: flex; flex-direction: column;">
                    
                            <div style="flex-grow: 1;">
                                <div style="color: #888; text-transform: uppercase; font-size: 0.85em; letter-spacing: 1px; font-weight: 700; margin-bottom: 10px;">
                                    📝 Question Content:
                                </div>
                                <p style="font-size: 1.3em; font-weight: 600; color: #2d3748; line-height: 1.5;">
                                    "${q.text || 'Unknown Question Content'}"
                                </p>
                            </div>
                    
                            <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee;">
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; font-size: 0.9em; color: #555;">
                                    <div style="background:#f7fafc; padding:8px; border-radius:6px;">
                                        🎯 Focus: <strong>${metrics.focus_score || 0}%</strong>
                                    </div>
                                    <div style="background:#f7fafc; padding:8px; border-radius:6px;">
                                        😶 Silence: <strong>${metrics.silence_ratio_percent || 0}%</strong>
                                    </div>
                                    <div style="background:#f7fafc; padding:8px; border-radius:6px;">
                                        📝 Words: <strong>${metrics.word_count || 0}</strong>
                                    </div>
                                    <div style="background:#f7fafc; padding:8px; border-radius:6px;">
                                        🗣️ Speed: <strong>${metrics.speaking_rate_wpm || 0}</strong>
                                    </div>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>
            `;
            container.innerHTML += html;
        });

    } catch (err) {
        container.innerHTML = `<p style="color:red; text-align:center;">Lỗi: ${err.message}</p>`;
    }
}
function backToDashboard() {
    // 1. Ẩn trang Review
    document.getElementById('step-admin-review').style.display = 'none';

    // 2. Tìm và dừng tất cả video đang chạy
    const videos = document.querySelectorAll('video');
    videos.forEach(v => {
        v.pause();      // Dừng video
        v.src = "";     // Ngắt kết nối video (để fix lỗi server báo pipe error)
        v.load();
    });

    // 3. Hiện lại trang Dashboard
    document.getElementById('step-dashboard').style.display = 'block';

    // (Tùy chọn) Load lại danh sách mới nhất để cập nhật trạng thái
    loadDashboard();
}

async function retryUpload() {
    const now = Date.now();
    if (now < nextRetryTime) {
        const remainingSeconds = Math.ceil((nextRetryTime - now) / 1000);
        alert(`⏳ Please wait ${remainingSeconds} more seconds`);
        return; // ← CHẶN nếu chưa đủ thời gian
    }
    // Ẩn nút retry
    document.getElementById('btn-retry-upload').style.display = 'none';
    
    // Kiểm tra còn lượt retry không
    if (uploadRetryCount >= MAX_RETRIES) {
        alert('❌ You have used all retry attempts. Please contact support.');
        return;
    }
    
    document.getElementById('btn-retry-upload').style.display = 'none';
    await uploadVideo(true);
}

async function adminLogin() {
    const username = document.getElementById('adminUsername').value.trim();
    const password = document.getElementById('adminPassword').value;
    const statusEl = document.getElementById('token-status');

    try {
        const res = await fetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (!res.ok) { statusEl.textContent = 'Wrong credentials!'; return; }
        statusEl.textContent = 'Welcome Admin';
        loadDashboard();
    } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
    }
}