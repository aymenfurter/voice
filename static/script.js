const chatMessages = document.getElementById('chat-messages');
const micBtn = document.getElementById('mic-btn');
const stopBtn = document.getElementById('stop-btn');
const aiCircle = document.querySelector('.ai-circle');
const statusText = document.querySelector('.status-text');
const toggleChatBtn = document.getElementById('toggle-chat-btn');
const chatContainer = document.querySelector('.chat-container');
const startBtn = document.getElementById('start-btn');

let isAssistantSpeaking = false;
let currentAudio = null;
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let silenceTimer = null;
let audioContext;
let analyser;
let microphone;
const silenceThreshold = -50; // dB
let wordCount = 0;
const shortPhraseThreshold = 3;
const shortPhraseSilenceDuration = 1000; // 1 second
const longPhraseSilenceDuration = 500; // 0.5 seconds
let conversationHistory = [];

// Audio context for sound effects
let audioCtx;

document.addEventListener('DOMContentLoaded', onStartup);
startBtn.addEventListener('click', startConversation);
micBtn.addEventListener('click', toggleRecording);
stopBtn.addEventListener('click', stopAssistant);
toggleChatBtn.addEventListener('click', toggleChatVisibility);

function startConversation() {
    startBtn.classList.add('hidden');
    micBtn.classList.remove('hidden');
    toggleChatBtn.classList.remove('hidden');
    getIntroMessage();
}

function toggleChatVisibility() {
    chatContainer.classList.toggle('hidden');
}

function playTone(frequency, duration) {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, audioCtx.currentTime);
    
    gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + duration);
}

function updateStatus(status) {
    statusText.textContent = status;
    aiCircle.className = 'ai-circle'; // Reset classes
    switch (status) {
        case 'Listening':
            aiCircle.classList.add('listening');
            playTone(880, 0.1); // Play A5 for 100ms
            break;
        case 'Thinking':
            aiCircle.classList.add('thinking');
            playTone(440, 0.1); // Play A4 for 100ms
            break;
        case 'Speaking':
            break;
        default:
            break;
    }
}

function addMessageToChat(sender, message) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', `${sender}-message`);
    messageElement.textContent = message;
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    // Add message to conversation history
    conversationHistory.push({
        role: sender === 'user' ? 'user' : 'assistant',
        content: message
    });
}

async function getAssistantResponse(message) {
    updateStatus('Thinking');
    try {
        const response = await fetch('/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ conversation_history: conversationHistory }),
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }
        addMessageToChat('assistant', data.response);
        updateStatus('Speaking');
        await playAudioResponse(data.audio);
        updateStatus('Listening');
        startRecording();
    } catch (error) {
        console.error('Error:', error);
        addMessageToChat('assistant', `Sorry, there was an error: ${error.message}`);
        updateStatus('Listening');
    }
}

function playAudioResponse(audioBase64) {
    return new Promise((resolve) => {
        const audio = new Audio(`data:audio/mp3;base64,${audioBase64}`);
        currentAudio = audio;
        isAssistantSpeaking = true;
        stopBtn.classList.remove('hidden');
        
        audio.addEventListener('ended', () => {
            isAssistantSpeaking = false;
            stopBtn.classList.add('hidden');
            resolve();
        });
        
        audio.play();
    });
}

function stopAssistant() {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
    }
    isAssistantSpeaking = false;
    stopBtn.classList.add('hidden');
    updateStatus('Listening');
}

function toggleRecording() {
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
}

async function startRecording() {
    if (isRecording) return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        microphone = audioContext.createMediaStreamSource(stream);
        microphone.connect(analyser);
        
        analyser.fftSize = 2048;
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        wordCount = 0;

        mediaRecorder.addEventListener("dataavailable", event => {
            audioChunks.push(event.data);
        });

        mediaRecorder.addEventListener("stop", async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
            await sendAudioToServer(audioBlob);
        });

        mediaRecorder.start(100); 
        isRecording = true;
        micBtn.classList.add('recording');
        updateStatus('Listening');

        detectSilence(dataArray, bufferLength, silenceThreshold);
    } catch (error) {
        console.error('Error starting recording:', error);
        alert('Unable to access the microphone. Please make sure it\'s connected and you\'ve granted permission.');
    }
}

function detectSilence(dataArray, bufferLength, threshold) {
    let silenceStart = performance.now();
    let silenceDetected = false;
    let lastSpeechTime = performance.now();
    let hasSpokeAtLeastOneWord = false;

    function checkAudioLevel() {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for(let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
        }
        let average = sum / bufferLength;
        let dB = 20 * Math.log10(average / 255);

        if (dB < threshold) {
            if (!silenceDetected) {
                silenceDetected = true;
                silenceStart = performance.now();
            } else {
                let currentSilenceDuration = performance.now() - silenceStart;
                let requiredSilenceDuration;

                if (wordCount > shortPhraseThreshold) {
                    requiredSilenceDuration = longPhraseSilenceDuration;
                } else if (hasSpokeAtLeastOneWord) {
                    requiredSilenceDuration = shortPhraseSilenceDuration;
                } else {
                    requiredSilenceDuration = Infinity; 
                }

                if (currentSilenceDuration > requiredSilenceDuration) {
                    stopRecording();
                    return;
                }
            }
        } else {
            silenceDetected = false;
            lastSpeechTime = performance.now();
            hasSpokeAtLeastOneWord = true;
        }

        if (isRecording) {
            requestAnimationFrame(checkAudioLevel);
        }
    }

    checkAudioLevel();
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        micBtn.classList.remove('recording');
        updateStatus('Thinking');
        
        if (audioContext) {
            audioContext.close();
        }
    }
}

async function sendAudioToServer(audioBlob) {
    updateStatus('Thinking');
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.wav');

    try {
        const response = await fetch('/speech_to_text', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }

        if (data.text.trim()) {
            addMessageToChat('user', data.text);
            wordCount = data.text.trim().split(/\s+/).length; // Update word count
            await getAssistantResponse(data.text);
        } else {
            startRecording(); // If no text was detected, start recording again
        }
    } catch (error) {
        console.error('Error:', error);
        addMessageToChat('system', `Sorry, there was an error processing your speech: ${error.message}`);
        startRecording(); // Restart recording even if there was an error
    }
}

async function onStartup() {
    // Initialize audio context
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

async function getIntroMessage() {
    updateStatus('Thinking');
    try {
        const response = await fetch('/intro', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }
        addMessageToChat('assistant', data.response);
        updateStatus('Speaking');
        await playAudioResponse(data.audio);
        updateStatus('Listening');
        startRecording(); 
    } catch (error) {
        console.error('Error:', error);
        addMessageToChat('assistant', `Sorry, there was an error: ${error.message}`);
        updateStatus('Listening');
    }
}