/**
 * BeePlayer HTTP Player
 * Lightweight standalone video player for HTTP streams
 * Handles MP4 (native), HLS (.m3u8), and MPEG-TS (.ts)
 */

// === Configuration ===
const BACKEND_URL = 'https://api.beeplayer1.com';

// === Localization ===
// Language comes from the `lang` query param (passed by the website based on the
// user's selected locale). Defaults to Arabic. Only 'ar' and 'en' are supported.
const LANG = (new URLSearchParams(window.location.search).get('lang') || 'ar')
  .toLowerCase()
  .startsWith('en')
  ? 'en'
  : 'ar';

const STRINGS = {
  ar: {
    providerError: 'يوجد خطأ من مصدر البث',
    errorTitle: 'خطأ في التشغيل',
    close: '✕ إغلاق',
    defaultTitle: 'مشغل الفيديو',
    noStreamUrl: 'لم يتم تحديد رابط البث',
    tokenMissing: 'رمز المصادقة مفقود. يرجى تسجيل الدخول مرة أخرى.',
    tokenInvalid: 'رمز المصادقة غير صالح أو منتهي الصلاحية. يرجى تسجيل الدخول مرة أخرى.',
    aborted: 'تم إلغاء تشغيل الفيديو.',
  },
  en: {
    providerError: 'There is an error from the stream source',
    errorTitle: 'Playback error',
    close: '✕ Close',
    defaultTitle: 'Video Player',
    noStreamUrl: 'No stream URL specified',
    tokenMissing: 'Authentication token is missing. Please log in again.',
    tokenInvalid: 'Authentication token is invalid or expired. Please log in again.',
    aborted: 'Video playback was aborted.',
  },
};
const T = STRINGS[LANG];
const PROVIDER_STREAM_ERROR = T.providerError;

// Cloudflare Worker stream proxy. Used as a fallback when a stream fails to play
// directly in the browser because of CORS (provider 302-redirects to a CDN that
// sends no Access-Control-Allow-Origin header). The Worker re-serves the stream
// with CORS headers from Cloudflare's edge IPs — NOT from our origin server — so
// the provider can't block our IP. Deploy cloudflare-worker/stream-proxy.js and
// paste its URL here (e.g. 'https://beeplayer-proxy.you.workers.dev').
// Leave '' to disable the Worker layer (player will skip straight to VLC fallback).
const WORKER_PROXY_URL = 'https://cloudflare-workerstream-proxyjs.ibrahimmo989800.workers.dev';

// === DOM Elements ===
const loadingScreen = document.getElementById('loading-screen');
const errorScreen = document.getElementById('error-screen');
const errorMessage = document.getElementById('error-message');
const playerContainer = document.getElementById('player-container');
const video = document.getElementById('video-player');
const titleBar = document.getElementById('title-bar');
const videoTitle = document.getElementById('video-title');
const controls = document.getElementById('controls');
const playBtn = document.getElementById('play-btn');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const progressBar = document.getElementById('progress-bar');
const currentTimeEl = document.getElementById('current-time');
const durationEl = document.getElementById('duration');
const volumeBar = document.getElementById('volume-bar');
const volumeIcon = document.getElementById('volume-icon');
const muteIcon = document.getElementById('mute-icon');
const videoWrapper = document.getElementById('video-wrapper');
const backLink = document.getElementById('back-link');

// === State ===
let hlsInstance = null;
let mpegtsPlayer = null;
let controlsTimer = null;
let isMuted = false;
let previousVolume = 100;
let streamUrl = '';
let token = '';
let title = '';
let returnUrl = '';
let triedWorker = false; // guard: only escalate to the Cloudflare Worker once

// === Init ===
(function init() {
    applyLocale();

    const params = new URLSearchParams(window.location.search);
    streamUrl = params.get('url') || '';
    token = params.get('token') || '';
    title = params.get('title') || T.defaultTitle;
    returnUrl = params.get('return') || '';

    videoTitle.textContent = decodeURIComponent(title);

    if (returnUrl) {
        backLink.href = decodeURIComponent(returnUrl);
        backLink.onclick = null; // Use the href
    }

    if (!streamUrl) {
        showError(T.noStreamUrl);
        return;
    }

    if (!token) {
        showError(T.tokenMissing);
        return;
    }

    // Validate token then play
    validateToken(token)
        .then(valid => {
            if (valid) {
                startPlayback(decodeURIComponent(streamUrl));
            } else {
                showError(T.tokenInvalid);
            }
        })
        .catch(err => {
            console.error('Token validation error:', err);
            // If validation fails (e.g. network error), still try to play
            // The stream might work anyway
            startPlayback(decodeURIComponent(streamUrl));
        });
})();

// === Token Validation ===
async function validateToken(token) {
    try {
        // 5-second timeout to avoid blocking playback
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const res = await fetch(`${BACKEND_URL}/customers/test`, {
            method: 'GET',
            mode: 'cors',
            headers: { 'Authorization': `Bearer ${token}` },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return res.ok;
    } catch (e) {
        // CORS or network error - allow playback to proceed
        // The stream URL itself is the real security gate (time-limited by IPTV provider)
        if (e.name === 'AbortError') {
            console.warn('Token validation timed out, proceeding with playback...');
        } else {
            console.warn('Token validation blocked (CORS/network), proceeding with playback...');
        }
        return true;
    }
}

// === Cloudflare Worker Fallback ===
// Wrap a stream URL so it routes through the Worker proxy (adds CORS headers).
function workerUrl(url) {
  return `${WORKER_PROXY_URL}?url=${encodeURIComponent(url)}`;
}

function workerConfigured() {
  return (
    WORKER_PROXY_URL &&
    !WORKER_PROXY_URL.includes("YOUR-SUBDOMAIN")
  );
}

// Is this URL already routed through the Worker proxy?
function isProxied(url) {
  return workerConfigured() && url.startsWith(WORKER_PROXY_URL);
}

// Given a (possibly proxied) URL, recover the original provider stream URL.
function streamUrlOriginal(url) {
  if (!isProxied(url)) return url;
  try {
    const q = new URL(url).searchParams.get("url");
    return q ? decodeURIComponent(q) : url;
  } catch (_) {
    return url;
  }
}

// Escalation: a direct-play attempt hit a CORS/network wall. If the Worker is
// configured and we haven't tried it yet, replay the SAME stream through the
// Worker. Returns true if it kicked off a Worker attempt (caller should stop).
function escalateToWorker(rawUrl) {
  if (triedWorker || !workerConfigured()) return false;
  triedWorker = true;
  cleanupPlayers();
  const proxied = workerUrl(rawUrl);
  console.log("🛰️ Escalating to Cloudflare Worker proxy...");
  const format = detectFormat(rawUrl); // detect on the ORIGINAL url (real extension)
  switch (format) {
    case "hls":
      playHLS(proxied);
      break;
    case "mpegts":
      playMpegTS(proxied);
      break;
    default:
      playNative(proxied);
      break;
  }
  return true;
}

// Last resort: everything failed (direct + Worker). Show the provider-outage
// message — no VLC/retry UI.
function showVlcFallback(rawUrl) {
  cleanupPlayers();
  // Reported here rather than on each fatal HLS error: the escalation chain
  // above recovers most of them, so only reaching this point is a real,
  // user-visible failure. lastPlaybackError carries the underlying cause.
  reportPlaybackFailure(rawUrl);
  showError(PROVIDER_STREAM_ERROR);
}

// Underlying cause of the current escalation chain, set by the HLS/mpegts
// handlers and consumed by showVlcFallback.
var lastPlaybackError = null;

function reportPlaybackFailure(rawUrl) {
  try {
    if (!window.BeeErrorReporter) return;
    window.BeeErrorReporter.report({
      errorType: (lastPlaybackError && lastPlaybackError.type) || "PlaybackFailed",
      message:
        "All playback approaches failed: " +
        ((lastPlaybackError && lastPlaybackError.details) || "unknown"),
      upstreamUrl: rawUrl,
      // The channel name is already in the launch URL's `title` param; sending
      // it explicitly is what puts "which channel broke" on the dashboard row.
      // `title` comes from URLSearchParams.get(), so it is already decoded —
      // decoding again would throw on any title containing a literal '%'.
      contentName: title ? String(title).slice(0, 200) : undefined,
      contentType: rawUrl && rawUrl.indexOf("/live/") !== -1 ? "live" : undefined,
      context: lastPlaybackError || undefined,
    });
    lastPlaybackError = null;
  } catch (_) {
    /* never break the error screen */
  }
}

function cleanupPlayers() {
  if (hlsInstance) {
    try { hlsInstance.destroy(); } catch (_) {}
    hlsInstance = null;
  }
  if (mpegtsPlayer) {
    try { mpegtsPlayer.destroy(); } catch (_) {}
    mpegtsPlayer = null;
  }
  video.removeAttribute("src");
  video.innerHTML = "";
}

// === Stream Format Detection ===
function detectFormat(url) {
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  // On iOS devices, Safari fully supports native HLS playback and HLS.js requires Media Source Extensions which aren't always available on iOS.
  if (isIOS) return "native";

  // Inspect only the path, not the query string. Xtream tokens often contain
  // substrings like ".ts" or "hls" that would otherwise mislead detection.
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch (_) {
    path = url.split("?")[0];
  }
  const lower = path.toLowerCase();

  if (lower.includes(".m3u8") || lower.includes("hls")) return "hls";
  if (
    lower.includes(".ts") ||
    lower.includes(".mpegts") ||
    lower.includes(".flv")
  )
    return "mpegts";
  if (
    lower.includes(".mp4") ||
    lower.includes(".avi") ||
    lower.includes(".mkv")
  )
    return "mp4";

  // Xtream Codes live streams are extensionless: /user/pass/streamId.
  // They stream raw MPEG-TS, which the native <video> element can't demux,
  // so route the extensionless channel id through mpegts.js.
  const lastSeg = lower.split("/").filter(Boolean).pop() || "";
  if (lastSeg && !lastSeg.includes(".")) return "mpegts";

  return "native";
}

// === Start Playback ===
function startPlayback(url) {
  const format = detectFormat(url);
  console.log(
    `🎬 Starting playback: format=${format}, url=${url.substring(0, 80)}...`,
  );

  showPlayer();

  switch (format) {
    case "hls":
      playHLS(url);
      break;
    case "mpegts":
      playMpegTS(url);
      break;
    case "mp4":
    default:
      playNative(url);
      break;
  }

  setupControls();
  setupKeyboard();
}

function playNative(url) {
  console.log("▶️ Using native video element");
  video.innerHTML = "";
  video.removeAttribute("src");

  // Assign `src` directly instead of using a <source> child. When a <source>
  // child fails to load, the `error` event fires on the <source>, NOT on the
  // <video>, so handleVideoError never ran — meaning movies/series (mp4/mkv/
  // native) never escalated to the Cloudflare Worker proxy the way live TV
  // (HLS/MPEG-TS) does. Setting video.src makes the <video> fire a reliable
  // `error`, wiring movies & series into the same Worker fallback chain.
  video.src = url;
  video.load();

  // Use onerror (assignment, not addEventListener) so repeated playNative calls
  // during the escalation chain don't stack duplicate error handlers.
  video.onerror = handleVideoError;

  video.addEventListener(
    "loadedmetadata",
    () => {
      console.log("✅ Video metadata loaded");
      hideLoading();
    },
    { once: true },
  );

  video.play().catch((err) => {
    console.warn("Autoplay failed:", err);
    if (err.name !== "NotAllowedError") {
      handleVideoError(err);
    } else {
      hideLoading();
    }
  });
}

// === HLS Playback ===
function playHLS(url) {
  if (typeof Hls === "undefined") {
    console.error("HLS.js not loaded");
    playNative(url); // Fallback
    return;
  }

  if (Hls.isSupported()) {
    console.log("▶️ Using HLS.js");
    hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
    });

    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(video);

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      console.log("✅ HLS manifest parsed");
      hideLoading();
      video.play().catch(() => hideLoading());
    });

    hlsInstance.on(Hls.Events.ERROR, (_, data) => {
      console.error("HLS error:", data);
      if (data.fatal) {
        // Remember the cause; showVlcFallback reports it if the escalation
        // chain below runs out of options.
        lastPlaybackError = {
          type: "Hls" + (data.type || "FatalError"),
          details: String(data.details || "unknown"),
          httpStatus: data.response && data.response.code,
        };
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.log(
              "🔄 HLS network error (CORS/redirect), checking for .ts fallback...",
            );
            hlsInstance.destroy();
            // Fallback for Xtream Codes live streams: try .ts format with mpegts.js
            if (
              url.includes("/live/") &&
              url.endsWith(".m3u8") &&
              typeof mpegts !== "undefined" &&
              mpegts.isSupported()
            ) {
              console.log(
                "🔄 Trying .ts fallback for Xtream Codes live stream...",
              );
              const tsUrl = url.replace(".m3u8", ".ts");
              playMpegTS(tsUrl);
            } else if (!isProxied(url) && escalateToWorker(streamUrlOriginal(url))) {
              // CORS wall on the manifest/segments → retry via Worker proxy.
              return;
            } else if (isProxied(url)) {
              console.log("❌ Worker proxy failed for HLS, showing VLC fallback...");
              showVlcFallback(streamUrlOriginal(url));
            } else {
              playNative(url); // Native video.src ignores CORS
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.log("🔄 HLS media error, attempting recovery...");
            hlsInstance.recoverMediaError();
            break;
          default:
            console.log("❌ Fatal HLS error, escalating...");
            hlsInstance.destroy();
            if (!isProxied(url) && escalateToWorker(streamUrlOriginal(url))) {
              return;
            }
            if (isProxied(url)) {
              showVlcFallback(streamUrlOriginal(url));
            } else {
              playNative(url);
            }
            break;
        }
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Safari native HLS
    playNative(url);
  } else {
    // Even if canPlayType is false, try native anyway as a last resort (often works on Android)
    playNative(url);
  }
}

// === MPEG-TS Playback ===
function playMpegTS(url) {
  if (typeof mpegts === "undefined") {
    console.error("mpegts.js not loaded");
    playNative(url); // Fallback
    return;
  }

  if (!mpegts.isSupported()) {
    playNative(url); // Fallback
    return;
  }

  console.log("▶️ Using mpegts.js");
  // Extensionless Xtream URLs (and /live/ paths) are continuous live feeds.
  // Detect on the ORIGINAL provider URL — when routed through the Worker the
  // real path is URL-encoded inside ?url=, so the raw `url` would misdetect.
  const detectUrl = streamUrlOriginal(url).toLowerCase();
  const lastSeg = (detectUrl.split("?")[0].split("/").filter(Boolean).pop() || "");
  const isLive = detectUrl.includes("/live/") || !lastSeg.includes(".");

  mpegtsPlayer = mpegts.createPlayer(
    {
      type: "mpegts",
      url: url,
      isLive: isLive,
      cors: true,
      hasAudio: true,
      hasVideo: true,
    },
    {
      enableWorker: true,
      lazyLoadMaxDuration: 3 * 60,
      seekType: "range",
      enableStashBuffer: true,
      stashInitialSize: 128,
      autoCleanupSourceBuffer: true,
    },
  );

  mpegtsPlayer.attachMediaElement(video);
  mpegtsPlayer.load();

  mpegtsPlayer.on(mpegts.Events.MEDIA_INFO, () => {
    console.log("✅ MPEG-TS media info received");
    hideLoading();
  });

  mpegtsPlayer.on(mpegts.Events.ERROR, (type, detail) => {
    console.error("mpegts error:", type, detail);
    // Recorded for showVlcFallback; see the HLS handler for the rationale.
    lastPlaybackError = {
      type: "Mpegts" + String(type || "Error"),
      details: String(detail || "unknown"),
    };
    // If this attempt was already the direct provider URL, the failure is almost
    // certainly CORS on a cross-origin 302 redirect. Native <video> can't demux
    // raw MPEG-TS, so escalate to the Worker proxy instead of native.
    if (!isProxied(url) && escalateToWorker(streamUrlOriginal(url))) {
      return;
    }
    // Worker attempt (or Worker disabled) also failed → show VLC fallback.
    if (isProxied(url)) {
      console.log("❌ Worker proxy failed for MPEG-TS, showing VLC fallback...");
      showVlcFallback(streamUrlOriginal(url));
      return;
    }
    console.log(
      "🔄 MPEG-TS error, no Worker configured, falling back to native...",
    );
    mpegtsPlayer.destroy();
    playNative(url);
  });

  video.play().catch((err) => {
    if (err.name !== "NotAllowedError") {
      handleVideoError(err);
    } else {
      hideLoading();
    }
  });
}

// === Error Handling ===
function handleVideoError(e) {
  console.error("Video error:", e);

  // Native <video> failed. Before showing an error, try the escalation chain:
  //   direct → Worker proxy → VLC fallback.
  const currentSrc = video.currentSrc || streamUrl;
  const original = streamUrlOriginal(currentSrc);

  // Network/format failures on a DIRECT url are usually CORS or an
  // unsupported container (e.g. raw MPEG-TS / .mkv). Try the Worker first.
  if (!isProxied(currentSrc) && escalateToWorker(original)) {
    return;
  }
  // Worker already tried (or disabled) → offer VLC as the last resort.
  if (isProxied(currentSrc) || (triedWorker && workerConfigured())) {
    console.log("❌ All in-browser attempts failed, showing VLC fallback...");
    showVlcFallback(original);
    return;
  }
  // Worker not configured and this was a direct attempt → VLC is the only option.
  if (!workerConfigured()) {
    showVlcFallback(original);
    return;
  }

  // Stream load/play failures are almost always the IPTV provider, not BeePlayer.
  let msg = PROVIDER_STREAM_ERROR;
  if (video.error && video.error.code === MediaError.MEDIA_ERR_ABORTED) {
    msg = T.aborted;
  }
  showError(msg);
}

// === UI Functions ===
function applyLocale() {
  document.documentElement.lang = LANG;
  document.documentElement.dir = LANG === "ar" ? "rtl" : "ltr";

  const titleEl = document.getElementById("error-title");
  if (titleEl) titleEl.textContent = T.errorTitle;

  const closeBtn = document.getElementById("error-close");
  if (closeBtn) closeBtn.textContent = T.close;

  if (errorMessage) errorMessage.textContent = T.providerError;
}

function showError(msg) {
  loadingScreen.classList.add("hidden");
  playerContainer.classList.add("hidden");
  errorScreen.classList.remove("hidden");
  errorMessage.textContent = msg;
}

function showPlayer() {
  loadingScreen.classList.add("hidden");
  errorScreen.classList.add("hidden");
  playerContainer.classList.remove("hidden");
}

function hideLoading() {
  loadingScreen.classList.add("hidden");
}

function retryPlayback() {
  errorScreen.classList.add("hidden");
  const fb = document.getElementById("vlc-fallback");
  if (fb) fb.classList.add("hidden");
  loadingScreen.classList.remove("hidden");
  playerContainer.classList.add("hidden");

  triedWorker = false; // fresh escalation chain on manual retry
  cleanupPlayers();

  startPlayback(decodeURIComponent(streamUrl));
}

function goBack() {
    if (returnUrl) {
        window.location.href = decodeURIComponent(returnUrl);
    } else {
        window.close();
        // If window.close() doesn't work (not opened via script), go back in history
        setTimeout(() => window.history.back(), 200);
    }
}

// === Controls ===
function setupControls() {
    // Play/pause on video click
    videoWrapper.addEventListener('click', (e) => {
        if (e.target === video || e.target === videoWrapper) {
            togglePlay();
        }
    });

    // Show/hide controls on mouse move
    videoWrapper.addEventListener('mousemove', showControlsTemporarily);
    videoWrapper.addEventListener('touchstart', showControlsTemporarily);

    // Video events
    video.addEventListener('play', () => updatePlayButton(true));
    video.addEventListener('pause', () => updatePlayButton(false));
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('loadedmetadata', () => {
        durationEl.textContent = formatTime(video.duration);
        progressBar.max = video.duration || 100;
    });

    // Progress bar seeking
    progressBar.addEventListener('input', (e) => {
        video.currentTime = parseFloat(e.target.value);
    });

    // Volume
    volumeBar.addEventListener('input', (e) => {
        const vol = parseInt(e.target.value);
        video.volume = vol / 100;
        isMuted = vol === 0;
        updateVolumeIcon();
    });

    // Double-click fullscreen
    videoWrapper.addEventListener('dblclick', toggleFullscreen);

    // Auto-hide controls
    showControlsTemporarily();
}

function showControlsTemporarily() {
    controls.classList.remove('hidden-controls');
    titleBar.classList.remove('hidden-controls');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => {
        if (!video.paused) {
            controls.classList.add('hidden-controls');
            titleBar.classList.add('hidden-controls');
        }
    }, 3000);
}

function updatePlayButton(playing) {
    playIcon.classList.toggle('hidden', playing);
    pauseIcon.classList.toggle('hidden', !playing);
}

function updateProgress() {
    if (video.duration && isFinite(video.duration)) {
        progressBar.value = video.currentTime;
        progressBar.max = video.duration;
        currentTimeEl.textContent = formatTime(video.currentTime);
        durationEl.textContent = formatTime(video.duration);
    }
}

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// === Player Controls ===
function togglePlay() {
    if (video.paused) {
        video.play().catch(err => console.warn('Play failed:', err));
    } else {
        video.pause();
    }
}

function skip(seconds) {
    if (video.duration && isFinite(video.duration)) {
        video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
    }
}

function toggleMute() {
    if (isMuted) {
        video.volume = previousVolume / 100;
        volumeBar.value = previousVolume;
        isMuted = false;
    } else {
        previousVolume = Math.round(video.volume * 100) || 100;
        video.volume = 0;
        volumeBar.value = 0;
        isMuted = true;
    }
    updateVolumeIcon();
}

function updateVolumeIcon() {
    volumeIcon.classList.toggle('hidden', isMuted);
    muteIcon.classList.toggle('hidden', !isMuted);
}

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        (playerContainer || document.documentElement).requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen().catch(() => {});
    }
}

// === Keyboard Shortcuts ===
function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        switch (e.key) {
            case ' ':
                e.preventDefault();
                togglePlay();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                skip(-10);
                break;
            case 'ArrowRight':
                e.preventDefault();
                skip(10);
                break;
            case 'ArrowUp':
                e.preventDefault();
                video.volume = Math.min(1, video.volume + 0.1);
                volumeBar.value = Math.round(video.volume * 100);
                break;
            case 'ArrowDown':
                e.preventDefault();
                video.volume = Math.max(0, video.volume - 0.1);
                volumeBar.value = Math.round(video.volume * 100);
                break;
            case 'm':
            case 'M':
                toggleMute();
                break;
            case 'f':
            case 'F':
                toggleFullscreen();
                break;
            case 'Escape':
                goBack();
                break;
        }
    });
}
