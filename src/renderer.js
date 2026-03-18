const { ipcRenderer, webUtils } = require('electron');
const path = require('path');
const fs = require('fs');
// soundtouchjs only ships ESM — load and convert to CJS on the fly
const _stCode = fs.readFileSync(
    path.resolve(__dirname, '../node_modules/soundtouchjs/dist/soundtouch.js'), 'utf-8'
).replace(/^export .+$/m, '');
// (SoundTouch is used inside the AudioWorklet, not on the main thread)

const { VIDEO_EXTENSIONS, ALL_EXTENSIONS } = require('./constants');
const SUPPORTED_EXTS_SET = new Set(ALL_EXTENSIONS.map(ext => `.${ext}`));
const VIDEO_EXTS_SET = new Set(VIDEO_EXTENSIONS.map(ext => `.${ext}`));

const openFileBtn = document.getElementById('openFile');
const audioPlayer = document.getElementById('audioPlayer');
const videoPlayer = document.getElementById('videoPlayer');
const currentFile = document.getElementById('currentFile');
const nowPlaying = document.getElementById('now-playing');
const lufsDisplay = document.getElementById('lufs-display');
const controls = document.getElementById('controls');
const visualiser = document.getElementById('visualiser-canvas');
const progressBar = document.getElementById('progress-bar');
const progress = document.getElementById('progress');
const volumeSlider = document.getElementById('volumeSlider');
const volumeValueDisplay = document.getElementById('volumeValue');
const volumeIcon = document.querySelector('.volume-icon');
const currentTimeDisplay = document.getElementById('current-time');
const remainingTimeDisplay = document.getElementById('remaining-time');
const playPauseButton = document.getElementById('playPauseButton');
const prevButton = document.getElementById('prevButton');
const nextButton = document.getElementById('nextButton');
const loopButton = document.getElementById('loopButton');

// Tempo/Pitch controls
const tempoSlider = document.getElementById('tempoSlider');
const pitchSlider = document.getElementById('pitchSlider');
const tempoValue = document.getElementById('tempoValue');
const pitchValue = document.getElementById('pitchValue');
const linkButton = document.getElementById('linkButton');
const resetPlaybackButton = document.getElementById('resetPlaybackButton');

let audioContext;
let animationFrameId; // ID of the requestAnimationFrame loop
let lufsNode, source;
let leftGainCanvas, rightGainCanvas;
let leftRMSCtx, rightRMSCtx;
let peakRMS = { left: -Infinity, right: -Infinity, overall: -Infinity }; // peak RMS tracker
let analyser;
let dataArray;
let currentFolder = null;
let currentIndex = -1;
let playlist = [];

// variables customisable by the user
let visualiserFftSize = 1024;
let volume = 100; // default volume is max
let prefEqStaysPaused = false;

// Tempo/Pitch state
let tempo = 100;       // 50-150%
let pitch = 0;         // -12.0 to 12.0 semitones
let linked = true;     // link toggle state (default: enabled)
let pitchProcessorNode = null; // AudioWorkletNode for pitch+tempo shifting
let pitchBypass = true; // true when pitch == 0, worklet not in chain
let workletReadyPromise = null; // resolves when AudioWorklet module is loaded
let loop = false;      // loop toggle state

let lastDataArray = null;

ipcRenderer.on('load-preferences', async (event, preferences) => {
    console.log('Loading preferences:', preferences);
    if (preferences.visualiserFftSize) visualiserFftSize = parseInt(preferences.visualiserFftSize, 10);
    if (preferences.eqStaysPaused !== undefined) prefEqStaysPaused = preferences.eqStaysPaused;
    if (preferences.volume) {
        volume = parseInt(preferences.volume, 10);
        volumeSlider.value = volume;
        audioPlayer.volume = volume / 100;
        videoPlayer.volume = volume / 100;
        updateVolumeIcon(volume / 100);
        volumeValueDisplay.textContent = volume + '%';
    }
    if (preferences.tempo !== undefined) {
        tempo = parseFloat(preferences.tempo);
        tempoSlider.value = tempo;
        tempoValue.textContent = Math.round(tempo) + '%';
        applyTempo();
    }
    if (preferences.pitch !== undefined) {
        pitch = parseFloat(preferences.pitch);
        pitchSlider.value = pitch;
        pitchValue.textContent = pitch.toFixed(1);
        applyPitch();
    }
    if (preferences.linked !== undefined) {
        linked = preferences.linked;
        updateLinkButton();
    }
    if (preferences.loop !== undefined) {
        loop = preferences.loop;
        updateLoopButton();
    }
    await setupVisualiser();
});

openFileBtn.addEventListener('click', () => {
    ipcRenderer.send('open-file-dialog');
});

ipcRenderer.on('selected-file', handleFileOpen);
ipcRenderer.on('open-file', handleFileOpen);

function handleFileOpen(event, filePath) {
    currentFolder = path.dirname(filePath);
    loadPlaylist(currentFolder, filePath);
    loadMedia(filePath);
}

function loadPlaylist(folder, selectedFile) {
    fs.readdir(folder, (err, files) => {
        if (err) {
            console.error('Error reading directory:', err);
            return;
        }
        playlist = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return SUPPORTED_EXTS_SET.has(ext);
        });
        currentIndex = playlist.indexOf(path.basename(selectedFile));
        updateButtonStates();
    });
}

async function loadMedia(filePath) {
    if (!filePath) return;
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTS_SET.has(ext)) return;

    // Immediately disconnect the audio chain so the old worklet's ring buffer
    // drains into nothing rather than into the speakers as the new file loads.
    cleanupAudio();

    const isVideo = VIDEO_EXTS_SET.has(ext);
    const mediaElement = isVideo ? videoPlayer : audioPlayer;

    document.getElementById('logo').classList.add('d-none'); // Hide logo
    mediaElement.src = filePath;
    let filename = path.basename(filePath).replace(/\.[^/.]+$/, '');
    currentFile.textContent = filename;
    nowPlaying.textContent = `Now playing: ${path.basename(filePath)}`;
    controls.classList.remove('d-none');

    if (isVideo) {
        videoPlayer.classList.remove('d-none');
        audioPlayer.classList.add('d-none');
        cleanupAudio();
        hideAudioUI();
        audioPlayer.src = '';
    } else {
        videoPlayer.classList.add('d-none');
        audioPlayer.classList.remove('d-none');
        videoPlayer.src = '';
        showAudioUI();
        await setupVisualiser();
    }

    applyTempo();
    updateButtonStates();
    togglePlayPause();
    lufsDisplay.textContent = 'LUFS: -∞ dB | RMS: -∞ dB';
}

function hideAudioUI() {
    visualiser.classList.add('d-none');
    lufsDisplay.classList.add('d-none');
    document.getElementById('left-gain-canvas').classList.add('d-none');
    document.getElementById('right-gain-canvas').classList.add('d-none');
    document.getElementById('controls').style.backgroundColor = 'rgba(0, 0, 0, 0.75)';
    document.getElementById('app-container').style.backgroundColor = 'black';
    // Hide pitch and link (pitch shifting not available for video)
    pitchSlider.parentElement.classList.add('d-none');
    linkButton.classList.add('d-none');
}

function showAudioUI() {
    visualiser.classList.remove('d-none');
    lufsDisplay.classList.remove('d-none');
    document.getElementById('left-gain-canvas').classList.remove('d-none');
    document.getElementById('right-gain-canvas').classList.remove('d-none');
    document.getElementById('controls').style.backgroundColor = '';
    document.getElementById('app-container').style.backgroundColor = '';
    pitchSlider.parentElement.classList.remove('d-none');
    linkButton.classList.remove('d-none');
}

function updateButtonStates() {
    prevButton.disabled = currentIndex <= 0;
    nextButton.disabled = currentIndex >= playlist.length - 1;
}

playPauseButton.addEventListener('click', togglePlayPause);
prevButton.addEventListener('click', playPrevious);
nextButton.addEventListener('click', playNext);

function togglePlayPause() {
    const mediaPlayer = videoPlayer.classList.contains('d-none') ? audioPlayer : videoPlayer;
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
    }
    if (mediaPlayer.paused) {
        mediaPlayer.play();
        playPauseButton.innerHTML = '<i class="material-icons-round">pause_circle</i>';
    } else {
        mediaPlayer.pause();
        playPauseButton.innerHTML = '<i class="material-icons-round">play_circle</i>';
    }
}

function playPrevious() {
    if (currentIndex > 0) {
        currentIndex--;
        loadMedia(path.join(currentFolder, playlist[currentIndex]));
    }
}

function playNext() {
    if (currentIndex < playlist.length - 1) {
        currentIndex++;
        loadMedia(path.join(currentFolder, playlist[currentIndex]));
    }
}

function updateVolumeIcon(volume) {
    if (volume > 0.5) {
        volumeIcon.textContent = 'volume_up';
    } else if (volume > 0) {
        volumeIcon.textContent = 'volume_down';
    } else {
        volumeIcon.textContent = 'volume_off';
    }
}

audioPlayer.addEventListener('timeupdate', updateProgress);
videoPlayer.addEventListener('timeupdate', updateProgress);
progressBar.addEventListener('click', seek);
progressBar.addEventListener('mousedown', startSeek);
progressBar.addEventListener('mouseleave', endSeek);

let isSeeking = false;

function startSeek() {
    isSeeking = true;
    progressBar.addEventListener('mousemove', updateSeek);
    progressBar.addEventListener('mouseup', endSeek);
}

function updateSeek(e) {
    if (isSeeking) {
        seek(e);
    }
}

function endSeek() {
    isSeeking = false;
    progressBar.removeEventListener('mousemove', updateSeek);
    progressBar.removeEventListener('mouseup', endSeek);
}

volumeSlider.addEventListener('input', function () {
    const volume = this.value / 100;
    audioPlayer.volume = volume;
    videoPlayer.volume = volume;
    updateVolumeIcon(volume);
    volumeValueDisplay.textContent = Math.round(this.value) + '%';

    //save volume to preferences
    ipcRenderer.send('save-preferences', { volume: this.value }, false); // reload all preferences = false
});

updateVolumeIcon(audioPlayer.volume);

function updateProgress() {
    const mediaPlayer = videoPlayer.classList.contains('d-none') ? audioPlayer : videoPlayer;
    const percent = (mediaPlayer.currentTime / mediaPlayer.duration) * 100;
    progress.style.width = `${percent}%`;
    currentTimeDisplay.textContent = formatTime(mediaPlayer.currentTime);
    remainingTimeDisplay.textContent = formatTime(mediaPlayer.duration - mediaPlayer.currentTime);
}

function seek(e) {
    const mediaPlayer = videoPlayer.classList.contains('d-none') ? audioPlayer : videoPlayer;
    const percent = e.offsetX / progressBar.offsetWidth;
    mediaPlayer.currentTime = percent * mediaPlayer.duration;
}

function formatTime(seconds) {
    if (isNaN(seconds)) return '--:--';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function cleanupAudio() {
    // Stop any ongoing animations
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }

    // Disconnect and clean up existing audio nodes if they exist
    if (source) {
        source.disconnect();
    }
    if (pitchProcessorNode) {
        pitchProcessorNode.disconnect();
        pitchProcessorNode = null; // Prevent stale node from being reconnected later
    }
    if (analyser) {
        analyser.disconnect();
    }
    if (lufsNode && lufsNode.node) {
        lufsNode.node.disconnect();
    }

    pitchBypass = true; // Reset so no accidental reconnection of old worklet
    peakRMS = { left: -Infinity, right: -Infinity, overall: -Infinity };
}

// Connects the audio graph, bypassing the worklet when at default settings
function connectAudioChain() {
    if (!audioContext || !source) return;

    // Disconnect everything first
    source.disconnect();
    if (pitchProcessorNode) pitchProcessorNode.disconnect();
    analyser.disconnect();
    if (lufsNode && lufsNode.node) lufsNode.node.disconnect();

    if (pitch === 0 && tempo === 100 || !pitchProcessorNode) {
        // Bypass: source → analyser → destination
        //         source → lufsNode → destination
        source.connect(analyser);
        analyser.connect(audioContext.destination);
        source.connect(lufsNode.node);
        lufsNode.node.connect(audioContext.destination);
        pitchBypass = true;
    } else {
        // source → pitchProcessor → analyser → destination
        //                         → lufsNode → destination
        source.connect(pitchProcessorNode);
        pitchProcessorNode.connect(analyser);
        analyser.connect(audioContext.destination);
        pitchProcessorNode.connect(lufsNode.node);
        lufsNode.node.connect(audioContext.destination);
        pitchBypass = false;
    }
}

async function setupVisualiser() {
    cleanupAudio();

    // Initialize audio context and nodes if not already done
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        lufsNode = createLoudnessMonitor(audioContext);
        source = audioContext.createMediaElementSource(audioPlayer);

        // Load the AudioWorklet module once — SoundTouch code is prepended so it
        // is available as a global inside the worklet's scope.
        const workletSrc = fs.readFileSync(path.resolve(__dirname, 'pitch-worklet.js'), 'utf-8');
        const blob = new Blob([_stCode + '\n' + workletSrc], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        workletReadyPromise = audioContext.audioWorklet.addModule(blobUrl)
            .then(() => URL.revokeObjectURL(blobUrl));
    }

    await workletReadyPromise;

    // Create a fresh AudioWorkletNode and sync current pitch state into it
    if (pitchProcessorNode) pitchProcessorNode.disconnect();
    pitchProcessorNode = new AudioWorkletNode(audioContext, 'pitch-tempo-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
    });
    pitchProcessorNode.port.postMessage({ stPitch: computeStPitch() });

    // Connect chain (bypasses worklet when pitch == 0)
    connectAudioChain();

    analyser.fftSize = visualiserFftSize;
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    lastDataArray = new Uint8Array(bufferLength); // store initial copy

    const canvasCtx = visualiser.getContext('2d');

    // Setup gain canvases
    leftGainCanvas = document.getElementById('left-gain-canvas');
    rightGainCanvas = document.getElementById('right-gain-canvas');

    leftRMSCtx = leftGainCanvas.getContext('2d');
    rightRMSCtx = rightGainCanvas.getContext('2d');

    // Set canvas sizes
    visualiser.width = visualiser.offsetWidth;
    visualiser.height = visualiser.offsetHeight;
    leftGainCanvas.width = leftGainCanvas.offsetWidth;
    leftGainCanvas.height = leftGainCanvas.offsetHeight;
    rightGainCanvas.width = rightGainCanvas.offsetWidth;
    rightGainCanvas.height = rightGainCanvas.offsetHeight;

    // Draw initial state for gain bars and loudness meter
    drawRMSCanvas(leftRMSCtx, -Infinity);
    drawRMSCanvas(rightRMSCtx, -Infinity);

    function draw() {
        animationFrameId = requestAnimationFrame(draw);

        // If EQ should stay in place when paused, skip updating if media is paused.
        const mediaPlayer = videoPlayer.classList.contains('d-none') ? audioPlayer : videoPlayer;
        if (prefEqStaysPaused && mediaPlayer.paused) {
            // Do not update visuals
            return;
        }

        analyser.getByteFrequencyData(dataArray);
        lastDataArray = dataArray.slice();

        // Update visualisations
        updateMainVisualiser(canvasCtx, bufferLength);
        updateLUFSDisplay();
    }

    draw();
}

function updateMainVisualiser(canvasCtx, bufferLength) {
    // Clear canvas
    canvasCtx.fillStyle = 'rgb(26, 26, 26)';
    canvasCtx.fillRect(0, 0, canvasCtx.canvas.width, canvasCtx.canvas.height);

    const barWidth = (canvasCtx.canvas.width / bufferLength) * 5;
    let barHeight;
    let x = 5;

    for (let i = 0; i < bufferLength; i++) {
        barHeight = Math.pow(dataArray[i] / 255, 2) * canvasCtx.canvas.height;

        // Calculate color based on loudness
        const hue = 60 - (dataArray[i] / 48) * 60;
        const color = `hsl(${hue}, 100%, 50%)`;

        canvasCtx.fillStyle = color;
        canvasCtx.fillRect(x, canvasCtx.canvas.height - barHeight, barWidth, barHeight);

        x += barWidth - 1;
    }
}

function drawRMSCanvas(ctx, rmsDB, side) {
    if (rmsDB === -Infinity) {
        peakRMS[side] = -Infinity; // reset peak RMS if no audio is playing
        peakRMS.overall = -Infinity; // reset overall peak RMS if no audio is playing
    }
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const minDB = -60; // Effectively -Infinity
    const maxDB = 6;
    const range = maxDB - minDB;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Clamp RMS value between minDB and maxDB
    const clampedRMS = Math.max(minDB, Math.min(maxDB, rmsDB));

    // Calculate bar height logarithmically
    const barHeight = height * (1 - (Math.log10((clampedRMS - minDB) / range + 1) / Math.log10(2)));

    // Draw RMS bar
    ctx.fillStyle = rmsDB > 0 ? 'red' : '#00ff00';
    ctx.fillRect(0, barHeight, width, height - barHeight);

    // Draw thick line at 0dB
    const zeroDbY = height * (1 - (Math.log10((-minDB) / range + 1) / Math.log10(2)));
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, zeroDbY, width, 3);

    //draw a thin green or red line at the peak RMS level
    peakRMS[side] = Math.max(peakRMS[side], rmsDB); // track the peak RMS level for this channel
    peakRMS.overall = Math.max(peakRMS.overall, peakRMS[side]); // track the overall peak RMS level
    const peakY = height * (1 - (Math.log10((peakRMS[side] - minDB) / range + 1) / Math.log10(2)));
    ctx.fillStyle = peakRMS[side] > 0 ? 'red' : 'green';
    ctx.fillRect(0, peakY, width, 2.5);
    // Check for clipping and draw a red line at the top if clipping
    if (rmsDB > 0) {
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, width, 5);
    }

    ctx.restore();

    ctx.restore();

    // Draw current RMS value
    ctx.save();
    ctx.translate(width / 2, barHeight + 50);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px Arial'; // Added 'bold' to make the text bold
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 1)'; // Added drop shadow
    ctx.shadowBlur = 1; // Added drop shadow
    ctx.shadowOffsetX = 2; // Added drop shadow
    ctx.shadowOffsetY = 2; // Added drop shadow

    if (rmsDB > 0) ctx.fillStyle = 'yellow';
    let rmsDBText = rmsDB === -Infinity ? '-∞' : rmsDB.toFixed(1);
    ctx.fillText(rmsDBText + ' dB', 0, 0);

    ctx.restore();
}

function createLoudnessMonitor(audioContext) {
    const bufferSize = 1024;
    const meter = audioContext.createScriptProcessor(bufferSize, 2, 2);
    let lufs = -70;
    const windowSize = audioContext.sampleRate * 4; // 2-second window
    let samples = new Float32Array(windowSize);
    let sampleIndex = 0;
    let totalSamples = 0;
    let sumOfSquares = 0;
    let rmsLeft = 0;
    let rmsRight = 0;

    // K-weighting filter coefficients (simplified)
    function kWeightingFilter(sample) {
        // Apply a simple high-pass filter as a placeholder for K-weighting
        const a = 1.5; // Placeholder coefficient
        return sample * a;
    }

    meter.onaudioprocess = function (e) {
        const inputBuffer = e.inputBuffer;
        const leftChannel = inputBuffer.getChannelData(0);
        const rightChannel = inputBuffer.getChannelData(1);

        let sumSquaresLeft = 0;
        let sumSquaresRight = 0;

        for (let i = 0; i < bufferSize; i++) {
            const mono = 0.5 * (leftChannel[i] + rightChannel[i]);
            const filtered = kWeightingFilter(mono);

            // LUFS calculation
            if (Math.abs(filtered) >= 0.0001) {
                samples[sampleIndex] = filtered * filtered;
                sampleIndex = (sampleIndex + 1) % windowSize;
                totalSamples++;
                sumOfSquares += filtered * filtered;
            }

            // RMS calculation
            sumSquaresLeft += leftChannel[i] * leftChannel[i];
            sumSquaresRight += rightChannel[i] * rightChannel[i];
        }

        // Calculate LUFS
        const sum = samples.reduce((acc, val) => acc + val, 0);
        const meanSquare = sum / windowSize;
        lufs = Math.max(-70, 10 * Math.log10(meanSquare) - 0.691);

        // Calculate RMS for left and right channels
        rmsLeft = Math.sqrt(sumSquaresLeft / bufferSize);
        rmsRight = Math.sqrt(sumSquaresRight / bufferSize);
    };

    return {
        node: meter,
        get lufs() { return lufs; },
        get rmsLeftDB() { return 20 * Math.log10(rmsLeft) + 6; },
        get rmsRightDB() { return 20 * Math.log10(rmsRight) + 6; }
    };
}

// Update the LUFS display more frequently
function updateLUFSDisplay() {
    if (lufsNode) {
        const lufs = lufsNode.lufs;
        drawRMSCanvas(leftRMSCtx, lufsNode.rmsLeftDB, 'left');
        drawRMSCanvas(rightRMSCtx, lufsNode.rmsRightDB, 'right');
        lufsDisplay.textContent = `LUFS: ${lufs === -70 || audioPlayer.paused || audioPlayer.volume === 0 ? '-∞' : lufs.toFixed(2)} dB | Peak RMS: ${peakRMS.overall.toFixed(2) === '-Infinity' ? '-∞' : peakRMS.overall.toFixed(2)} dB`;
    }
}

// Ensure the canvas size matches its display size
function resizeCanvas() {
    visualiser.width = visualiser.clientWidth;
    visualiser.height = visualiser.clientHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

document.addEventListener('dragover', function (event) {
    event.preventDefault();
    document.getElementById('drop-area').classList.remove('d-none');
});

document.addEventListener('dragleave', function (event) {
    event.preventDefault();
    if (event.target === document.getElementById('drop-area')) {
        document.getElementById('drop-area').classList.add('d-none');
    }
});

document.addEventListener('drop', function (event) {
    event.preventDefault();
    document.getElementById('drop-area').classList.add('d-none');

    const files = event.dataTransfer.files;
    if (files.length > 0) {
        const filePath = webUtils.getPathForFile(files[0]);
        currentFolder = path.dirname(filePath);
        loadPlaylist(currentFolder, filePath);
        loadMedia(filePath);
    }
});

// Playback controls idle hide for video mode
let controlsHideTimeout = null;
function scheduleControlsHide() {
    clearTimeout(controlsHideTimeout);
    controlsHideTimeout = setTimeout(() => {
        // Only hide if video player is visible and is playing
        if (!videoPlayer.classList.contains('d-none') && !videoPlayer.paused) {
            controls.style.transition = 'transform 0.5s ease';
            controls.style.transform = 'translateY(100%)';
        }
    }, 2000);
}

function showControls() {
    clearTimeout(controlsHideTimeout);
    controls.style.transition = 'transform 0.3s ease';
    controls.style.transform = 'translateY(0)';
    // Reschedule hiding if video is playing
    if (!videoPlayer.classList.contains('d-none') && !videoPlayer.paused) {
        scheduleControlsHide();
    }
}
document.addEventListener('mousemove', showControls);
document.addEventListener('mousedown', showControls);
videoPlayer.addEventListener('pause', showControls);
document.addEventListener('mouseleave', () => {
    if (!videoPlayer.classList.contains('d-none') && !videoPlayer.paused) {
        controls.style.transform = 'translateY(100%)';
    }
});
videoPlayer.addEventListener('play', scheduleControlsHide);

document.addEventListener('keydown', function (e) {
    // Ignore if focus is on an input, textarea, or contenteditable element
    const active = document.activeElement;
    if (
        active && (
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable
        )
    ) return;

    const mediaPlayer = videoPlayer.classList.contains('d-none') ? audioPlayer : videoPlayer;

    switch (e.code) {
        case 'Space':
            e.preventDefault();
            togglePlayPause();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            mediaPlayer.currentTime = Math.max(0, mediaPlayer.currentTime - 10);
            break;
        case 'ArrowRight':
            e.preventDefault();
            mediaPlayer.currentTime = Math.min(mediaPlayer.duration || 0, mediaPlayer.currentTime + 10);
            break;
        case 'ArrowUp':
            e.preventDefault();
            let newVolUp = Math.min(1, mediaPlayer.volume + 0.05);
            mediaPlayer.volume = newVolUp;
            audioPlayer.volume = newVolUp;
            videoPlayer.volume = newVolUp;
            volumeSlider.value = Math.round(newVolUp * 100);
            updateVolumeIcon(newVolUp);
            volumeValueDisplay.textContent = Math.round(newVolUp * 100) + '%';
            ipcRenderer.send('save-preferences', { volume: volumeSlider.value }, false);
            break;
        case 'ArrowDown':
            e.preventDefault();
            let newVolDown = Math.max(0, mediaPlayer.volume - 0.05);
            mediaPlayer.volume = newVolDown;
            audioPlayer.volume = newVolDown;
            videoPlayer.volume = newVolDown;
            volumeSlider.value = Math.round(newVolDown * 100);
            updateVolumeIcon(newVolDown);
            volumeValueDisplay.textContent = Math.round(newVolDown * 100) + '%';
            ipcRenderer.send('save-preferences', { volume: volumeSlider.value }, false);
            break;
    }
});

// --- Tempo/Pitch Controls ---

// SoundTouch pitch multiplier: undoes the pitch change from playbackRate
// (playing at tempo/100 shifts pitch by 100/tempo) then adds user pitch offset.
function computeStPitch() {
    return (100 / tempo) * Math.pow(2, pitch / 12);
}

function applyTempo() {
    const rate = tempo / 100;
    audioPlayer.playbackRate = rate;
    videoPlayer.playbackRate = rate;

    if (pitchProcessorNode && !pitchBypass) {
        // Worklet is correcting the pitch; tell the browser not to double-process.
        audioPlayer.preservesPitch = false;
        videoPlayer.preservesPitch = false;
        pitchProcessorNode.port.postMessage({ stPitch: computeStPitch() });
    } else {
        // Bypass: let the browser handle pitch correction natively.
        audioPlayer.preservesPitch = true;
        videoPlayer.preservesPitch = true;
    }
}

function applyPitch() {
    const shouldBypass = pitch === 0 && tempo === 100;
    if (audioContext && source && shouldBypass !== pitchBypass) {
        connectAudioChain();
    }
    if (pitchProcessorNode && !pitchBypass) {
        audioPlayer.preservesPitch = false;
        videoPlayer.preservesPitch = false;
        pitchProcessorNode.port.postMessage({ stPitch: computeStPitch() });
    } else {
        audioPlayer.preservesPitch = true;
        videoPlayer.preservesPitch = true;
    }
}

function updateLinkButton() {
    const icon = linkButton.querySelector('i');
    if (linked) {
        icon.textContent = 'link';
        linkButton.classList.add('linked');
    } else {
        icon.textContent = 'link_off';
        linkButton.classList.remove('linked');
    }
}

tempoSlider.addEventListener('input', function () {
    tempo = parseFloat(this.value);
    tempoValue.textContent = Math.round(tempo) + '%';
    applyTempo();

    if (linked) {
        // Proportional: semitones = 12 * log2(rate)
        pitch = 12 * Math.log2(tempo / 100);
        pitch = Math.max(-12, Math.min(12, pitch));
        pitchSlider.value = pitch;
        pitchValue.textContent = pitch.toFixed(1);
        applyPitch();
    }

    ipcRenderer.send('save-preferences', { tempo, pitch }, false);
});

pitchSlider.addEventListener('input', function () {
    pitch = parseFloat(this.value);
    pitchValue.textContent = pitch.toFixed(1);
    applyPitch();

    if (linked) {
        // Proportional: rate = 2^(semitones/12)
        tempo = 100 * Math.pow(2, pitch / 12);
        tempo = Math.max(50, Math.min(150, tempo));
        tempoSlider.value = tempo;
        tempoValue.textContent = Math.round(tempo) + '%';
        applyTempo();
    }

    ipcRenderer.send('save-preferences', { tempo, pitch }, false);
});

// --- Click-to-edit for tempo/pitch values ---

function startValueEdit(span, currentValue, suffix, onCommit) {
    if (span.querySelector('input')) return; // already editing

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'slider-value-input';
    input.value = currentValue;
    span.textContent = '';
    span.appendChild(input);
    input.focus();
    input.select();

    function commit() {
        const raw = parseFloat(input.value);
        if (!isNaN(raw)) onCommit(raw);
        // onCommit restores the span text, but if parse failed restore previous
        if (span.querySelector('input')) span.textContent = currentValue + suffix;
    }

    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); span.textContent = currentValue + suffix; }
    });
    input.addEventListener('blur', commit);
}

tempoValue.addEventListener('click', function () {
    startValueEdit(tempoValue, Math.round(tempo), '%', function (val) {
        tempo = Math.max(50, Math.min(150, val));
        tempoSlider.value = tempo;
        tempoValue.textContent = Math.round(tempo) + '%';
        applyTempo();

        if (linked) {
            pitch = 12 * Math.log2(tempo / 100);
            pitch = Math.max(-12, Math.min(12, pitch));
            pitchSlider.value = pitch;
            pitchValue.textContent = pitch.toFixed(1);
            applyPitch();
        }

        ipcRenderer.send('save-preferences', { tempo, pitch }, false);
    });
});

pitchValue.addEventListener('click', function () {
    startValueEdit(pitchValue, pitch.toFixed(1), '', function (val) {
        pitch = Math.max(-12, Math.min(12, val));
        pitchSlider.value = pitch;
        pitchValue.textContent = pitch.toFixed(1);
        applyPitch();

        if (linked) {
            tempo = 100 * Math.pow(2, pitch / 12);
            tempo = Math.max(50, Math.min(150, tempo));
            tempoSlider.value = tempo;
            tempoValue.textContent = Math.round(tempo) + '%';
            applyTempo();
        }

        ipcRenderer.send('save-preferences', { tempo, pitch }, false);
    });
});

linkButton.addEventListener('click', function () {
    linked = !linked;
    updateLinkButton();
    ipcRenderer.send('save-preferences', { linked }, false);
});

// --- Loop Control ---

function updateLoopButton() {
    if (loop) {
        loopButton.classList.add('active');
    } else {
        loopButton.classList.remove('active');
    }
}

loopButton.addEventListener('click', function () {
    loop = !loop;
    updateLoopButton();
    ipcRenderer.send('save-preferences', { loop }, false);
});

function handleMediaEnded() {
    if (loop) {
        const mediaPlayer = videoPlayer.classList.contains('d-none') ? audioPlayer : videoPlayer;
        mediaPlayer.currentTime = 0;
        mediaPlayer.play();
        playPauseButton.innerHTML = '<i class="material-icons-round">pause_circle</i>';
    } else {
        playPauseButton.innerHTML = '<i class="material-icons-round">play_circle</i>';
    }
}

audioPlayer.addEventListener('ended', handleMediaEnded);
videoPlayer.addEventListener('ended', handleMediaEnded);

// After a seek, flush stale samples from the SoundTouch ring buffer
audioPlayer.addEventListener('seeking', () => {
    if (pitchProcessorNode && !pitchBypass) {
        pitchProcessorNode.port.postMessage({ flush: true });
    }
});

resetPlaybackButton.addEventListener('click', function () {
    tempo = 100;
    pitch = 0;
    linked = true;

    tempoSlider.value = 100;
    pitchSlider.value = 0;
    tempoValue.textContent = '100%';
    pitchValue.textContent = '0.0';

    applyTempo();
    applyPitch();
    updateLinkButton();

    ipcRenderer.send('save-preferences', { tempo, pitch, linked }, false);
});