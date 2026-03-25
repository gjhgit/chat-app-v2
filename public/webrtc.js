/* ═══════════════════════════════════════════
   WebRTC 音视频通话 & 语音消息
═══════════════════════════════════════════ */

// ═══════════════════════════════════════════
// 语音消息录制
// ═══════════════════════════════════════════
let voiceRecorder = null;
let voiceChunks = [];
let voiceStartTime = 0;
let voiceTimer = null;
let voiceStream = null;
let recordedBlob = null;

function toggleVoiceRecorder() {
  const panel = document.getElementById('voice-recorder');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    initVoiceWave();
  }
}

function initVoiceWave() {
  const wave = document.getElementById('voice-wave');
  wave.innerHTML = '';
  for (let i = 0; i < 20; i++) {
    const bar = document.createElement('span');
    bar.style.height = '10px';
    bar.style.animationDelay = `${i * 0.05}s`;
    wave.appendChild(bar);
  }
}

async function startVoiceRecord() {
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceRecorder = new MediaRecorder(voiceStream);
    voiceChunks = [];
    
    voiceRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceChunks.push(e.data);
    };
    
    voiceRecorder.onstop = () => {
      recordedBlob = new Blob(voiceChunks, { type: 'audio/webm' });
      voiceStream.getTracks().forEach(t => t.stop());
    };
    
    voiceRecorder.start();
    voiceStartTime = Date.now();
    
    // 更新UI
    document.getElementById('voice-record-btn').classList.add('recording');
    
    // 开始计时
    voiceTimer = setInterval(updateVoiceTime, 1000);
    
  } catch (err) {
    showToast('无法访问麦克风: ' + err.message);
  }
}

function stopVoiceRecord() {
  if (!voiceRecorder || voiceRecorder.state === 'inactive') return;
  
  voiceRecorder.stop();
  clearInterval(voiceTimer);
  document.getElementById('voice-record-btn').classList.remove('recording');
  
  const duration = Math.floor((Date.now() - voiceStartTime) / 1000);
  document.getElementById('voice-time').textContent = formatDuration(duration);
}

function updateVoiceTime() {
  const duration = Math.floor((Date.now() - voiceStartTime) / 1000);
  document.getElementById('voice-time').textContent = formatDuration(duration);
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function cancelVoiceRecord() {
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    voiceRecorder.stop();
    voiceStream.getTracks().forEach(t => t.stop());
  }
  clearInterval(voiceTimer);
  recordedBlob = null;
  document.getElementById('voice-time').textContent = '00:00';
  document.getElementById('voice-record-btn').classList.remove('recording');
  document.getElementById('voice-recorder').classList.add('hidden');
}

async function sendVoiceMessage() {
  if (!recordedBlob) {
    showToast('请先录制语音');
    return;
  }
  
  if (!state.currentRoomId) {
    showToast('请先选择聊天室');
    return;
  }
  
  const duration = Math.floor((Date.now() - voiceStartTime) / 1000);
  
  // 创建 FormData 上传
  const formData = new FormData();
  formData.append('file', recordedBlob, 'voice.webm');
  
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Authorization': state.token },
      body: formData
    });
    
    const data = await res.json();
    
    // 发送语音消息
    socket.emit('message', {
      roomId: state.currentRoomId,
      content: `[语音] ${duration}秒`,
      type: 'voice',
      fileUrl: data.url,
      fileName: 'voice.webm',
      duration: duration
    });
    
    // 重置
    cancelVoiceRecord();
    
  } catch (err) {
    showToast('发送失败: ' + err.message);
  }
}

// ═══════════════════════════════════════════
// WebRTC 音视频通话
// ═══════════════════════════════════════════
let localStream = null;
let remoteStream = null;
let peerConnection = null;
let currentCall = null;
let isMuted = false;
let isVideoOff = false;

const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// 发起视频通话
async function startVideoCall() {
  if (!state.currentRoomId || state.currentRoomId === 'public') {
    showToast('只能在私聊中发起通话');
    return;
  }
  
  const room = state.rooms.get(state.currentRoomId);
  if (!room || room.type !== 'private') {
    showToast('只能在私聊中发起通话');
    return;
  }
  
  const otherUser = getOtherUserInPrivateRoom(room);
  if (!otherUser) {
    showToast('无法获取对方信息');
    return;
  }
  
  await startCall(otherUser, 'video');
}

// 发起语音通话
async function startAudioCall() {
  if (!state.currentRoomId || state.currentRoomId === 'public') {
    showToast('只能在私聊中发起通话');
    return;
  }
  
  const room = state.rooms.get(state.currentRoomId);
  if (!room || room.type !== 'private') {
    showToast('只能在私聊中发起通话');
    return;
  }
  
  const otherUser = getOtherUserInPrivateRoom(room);
  if (!otherUser) {
    showToast('无法获取对方信息');
    return;
  }
  
  await startCall(otherUser, 'audio');
}

async function startCall(targetUser, type) {
  try {
    // 获取本地媒体
    const constraints = type === 'video' 
      ? { video: true, audio: true }
      : { video: false, audio: true };
    
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    // 创建 PeerConnection
    peerConnection = new RTCPeerConnection(iceServers);
    
    // 添加本地流
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    
    // 监听远程流
    peerConnection.ontrack = (e) => {
      remoteStream = e.streams[0];
      document.getElementById('remote-video').srcObject = remoteStream;
    };
    
    // 监听 ICE 候选
    peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('ice_candidate', {
          targetId: targetUser.id,
          candidate: e.candidate
        });
      }
    };
    
    // 创建 Offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    // 发送呼叫请求
    socket.emit('call_request', {
      targetId: targetUser.id,
      type: type,
      offer: offer
    });
    
    // 显示通话界面
    showCallUI(targetUser, type, 'calling');
    
    currentCall = {
      targetId: targetUser.id,
      type: type,
      status: 'calling'
    };
    
  } catch (err) {
    showToast('无法启动通话: ' + err.message);
    endCall();
  }
}

// 显示通话界面
function showCallUI(user, type, status) {
  document.getElementById('call-name').textContent = user.username;
  document.getElementById('call-status').textContent = 
    status === 'calling' ? '正在呼叫...' : '通话中';
  
  const avatarEl = document.getElementById('call-avatar');
  avatarEl.textContent = (user.username || '?').slice(0, 2);
  avatarEl.style.background = user.color || '#888';
  
  // 显示本地视频
  if (localStream) {
    document.getElementById('local-video').srcObject = localStream;
  }
  
  // 视频通话时显示视频元素，语音通话时隐藏
  const remoteVideo = document.getElementById('remote-video');
  if (type === 'audio') {
    remoteVideo.style.display = 'none';
  } else {
    remoteVideo.style.display = 'block';
  }
  
  document.getElementById('call-modal').classList.remove('hidden');
}

// 接听来电
async function acceptCall() {
  if (!incomingCall) return;
  
  try {
    const constraints = incomingCall.type === 'video'
      ? { video: true, audio: true }
      : { video: false, audio: true };
    
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    peerConnection = new RTCPeerConnection(iceServers);
    
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    
    peerConnection.ontrack = (e) => {
      remoteStream = e.streams[0];
      document.getElementById('remote-video').srcObject = remoteStream;
    };
    
    peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('ice_candidate', {
          targetId: incomingCall.callerId,
          candidate: e.candidate
        });
      }
    };
    
    // 设置远程描述
    await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
    
    // 创建 Answer
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    // 发送应答
    socket.emit('call_answer', {
      targetId: incomingCall.callerId,
      answer: answer
    });
    
    // 隐藏来电提示，显示通话界面
    document.getElementById('incoming-call-modal').classList.add('hidden');
    
    const caller = state.users.get(incomingCall.callerId);
    showCallUI(caller, incomingCall.type, 'connected');
    
    currentCall = {
      targetId: incomingCall.callerId,
      type: incomingCall.type,
      status: 'connected'
    };
    
    incomingCall = null;
    
  } catch (err) {
    showToast('接听失败: ' + err.message);
    declineCall();
  }
}

// 拒绝来电
function declineCall() {
  if (incomingCall) {
    socket.emit('call_decline', { targetId: incomingCall.callerId });
    incomingCall = null;
  }
  document.getElementById('incoming-call-modal').classList.add('hidden');
}

// 挂断通话
function endCall() {
  if (currentCall) {
    socket.emit('call_end', { targetId: currentCall.targetId });
  }
  
  // 关闭媒体流
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  remoteStream = null;
  currentCall = null;
  isMuted = false;
  isVideoOff = false;
  
  // 隐藏通话界面
  document.getElementById('call-modal').classList.add('hidden');
  document.getElementById('local-video').srcObject = null;
  document.getElementById('remote-video').srcObject = null;
}

// 静音切换
function toggleMute() {
  if (!localStream) return;
  
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !isMuted;
  });
  
  document.getElementById('mute-btn').classList.toggle('muted', isMuted);
}

// 视频切换
function toggleVideo() {
  if (!localStream) return;
  
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks().forEach(track => {
    track.enabled = !isVideoOff;
  });
  
  document.getElementById('video-btn').classList.toggle('muted', isVideoOff);
}

// ═══════════════════════════════════════════
// Socket 事件监听
// ═══════════════════════════════════════════
let incomingCall = null;

function initWebRTCEvents() {
  // 收到呼叫请求
  socket.on('call_request', ({ callerId, type, offer }) => {
    const caller = state.users.get(callerId);
    if (!caller) return;
    
    incomingCall = { callerId, type, offer };
    
    // 显示来电提示
    document.getElementById('incoming-name').textContent = caller.username;
    document.getElementById('incoming-type').textContent = 
      type === 'video' ? '视频来电' : '语音来电';
    
    const avatarEl = document.getElementById('incoming-avatar');
    avatarEl.textContent = (caller.username || '?').slice(0, 2);
    avatarEl.style.background = caller.color || '#888';
    
    document.getElementById('incoming-call-modal').classList.remove('hidden');
    
    // 播放铃声
    playRingtone();
  });
  
  // 对方接听
  socket.on('call_answer', ({ answer }) => {
    if (peerConnection) {
      peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      document.getElementById('call-status').textContent = '通话中';
      if (currentCall) currentCall.status = 'connected';
    }
  });
  
  // 对方拒绝
  socket.on('call_decline', () => {
    showToast('对方拒绝了通话');
    endCall();
  });
  
  // 对方挂断
  socket.on('call_end', () => {
    showToast('通话已结束');
    endCall();
  });
  
  // 收到 ICE 候选
  socket.on('ice_candidate', ({ candidate }) => {
    if (peerConnection) {
      peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  });
}

// 播放铃声
let ringtoneAudio = null;
function playRingtone() {
  // 使用简单的音频上下文生成铃声
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  
  const ctx = new AudioContext();
  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();
  
  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);
  
  oscillator.frequency.value = 800;
  gainNode.gain.value = 0.3;
  
  oscillator.start();
  
  // 响铃3秒
  setTimeout(() => {
    oscillator.stop();
    ctx.close();
  }, 3000);
}

// 在初始化时调用
if (typeof socket !== 'undefined') {
  initWebRTCEvents();
}
