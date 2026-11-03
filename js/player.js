/**
 * BeePlayer HTTP Player
 * Lightweight standalone video player for HTTP streams
 * Handles MP4 (native), HLS (.m3u8), and MPEG-TS (.ts)
 */

// === Configuration ===
const BACKEND_URL = 'https://api.beeplayer1.com';

// === Launch parameters ===
// The site opens this page as http://player.beeplayer1.com/#url=…&ticket=…
// &title=…&return=…&lang=… — everything in the URL fragment, which the browser
// never sends to a server, so the provider URL and ticket stay out of HTTP
// request lines, nginx logs and Referer headers. The ticket is a short-lived,
// single-stream pass from the backend (POST /auth/playback-ticket), never the
// customer's session token. init() clears the fragment from the address bar.
const LAUNCH = new URLSearchParams(window.location.hash.slice(1));

// === Localization ===
// Language comes from the `lang` launch param (passed by the website based on the
// user's selected locale). Defaults to Arabic. Only 'ar' and 'en' are supported.
const LANG = (LAUNCH.get('lang') || 'ar')
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
    ticketInvalid: 'رابط التشغيل غير صالح أو منتهي الصلاحية. يرجى فتحه من الموقع مرة أخرى.',
    aborted: 'تم إلغاء تشغيل الفيديو.',
    geoTitle: 'القناة محظورة في بلدك',
    geoBlocked:
      'مزود البث يمنع المشاهدة من بلدك أو من شبكتك الحالية. هذه ليست مشكلة في BeePlayer. جرّب قائمة تشغيل أخرى أو تواصل مع مزود الخدمة.',
    providerCode: 'رمز المزود',
  },
  en: {
    providerError: 'There is an error from the stream source',
    errorTitle: 'Playback error',
    close: '✕ Close',
    defaultTitle: 'Video Player',
    noStreamUrl: 'No stream URL specified',
    ticketInvalid: 'This playback link is invalid or expired. Please open it again from the website.',
    aborted: 'Video playback was aborted.',
    geoTitle: 'Blocked in your country',
    geoBlocked:
      'The stream provider does not allow viewing from your country or current network. This is not a BeePlayer problem. Try another playlist or contact your provider.',
    providerCode: 'Provider code',
  },
};
const T = STRINGS[LANG];
const PROVIDER_STREAM_ERROR = T.providerError;

// === Provider geo-blocking ===
// Xtream panels answer a refused location with a vendor status code rather than
// a standard one: 459 carries a "country-not-allow" body, 467 is the same
// refusal with an empty body (the code the backend already treats as a provider
// block — see iptv.service.ts). 451 is the standard legal/geo refusal.
const GEO_BLOCK_STATUSES = [451, 459, 467];
const GEO_BLOCK_BODY_PATTERN =
  /country[\s_-]?not[\s_-]?allow|not available in your (region|country)|geo[\s-]?block/i;

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
let ticket = '';
let title = '';
let returnUrl = '';
let triedWorker = false; // guard: only escalate to the Cloudflare Worker once
let controlsReady = false; // UI listeners are registered once, not per retry

// === Init ===
(function init() {
    applyLocale();

    // URLSearchParams already decodes; do not decode again.
    streamUrl = LAUNCH.get('url') || '';
    ticket = LAUNCH.get('ticket') || '';
    title = LAUNCH.get('title') || T.defaultTitle;
    returnUrl = LAUNCH.get('return') || '';

    // Drop the fragment from the address bar and history.
    history.replaceState(null, '', window.location.pathname);

    videoTitle.textContent = title;

    if (isSafeReturnUrl(returnUrl)) {
        backLink.href = returnUrl;
        backLink.onclick = null; // Use the href
    }

    if (!streamUrl) {
        showError(T.noStreamUrl);
        return;
    }

    playIfTicketValid();
})();

// The only way into playback, on first load and on retry: no ticket the
// backend accepts for this stream, no playback.
function playIfTicketValid() {
    if (!streamUrl || !ticket) {
        showError(T.ticketInvalid);
        return;
    }
    verifyTicket(ticket, streamUrl).then(valid => {
        if (valid) {
            startPlayback(streamUrl);
        } else {
            showError(T.ticketInvalid);
        }
    });
}

// Only send people back to the BeePlayer site itself.
function isSafeReturnUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' &&
            (parsed.hostname === 'beeplayer1.com' || parsed.hostname === 'www.beeplayer1.com');
    } catch (e) {
        return false;
    }
}

// === Ticket Verification ===
// Fails closed: a rejected ticket, a timeout or a network error all stop here.
async function verifyTicket(ticket, url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(`${BACKEND_URL}/auth/playback-ticket/verify`, {
            method: 'POST',
            mode: 'cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket, url }),
            signal: controller.signal,
        });
        return res.ok;
    } catch (e) {
        console.warn('Playback ticket verification failed');
        return false;
    } finally {
        clearTimeout(timeoutId);
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

// Is this provider response a geo-block rather than an ordinary outage?
// `body` is optional: 467 arrives with an empty body, so the status alone has
// to be enough to classify it.
function isGeoBlock(status, body) {
  if (GEO_BLOCK_STATUSES.indexOf(Number(status)) !== -1) return true;
  return !!body && GEO_BLOCK_BODY_PATTERN.test(body);
}

/**
 * Ask the provider directly why playback failed.
 *
 * hls.js surfaces the upstream status, but mpegts.js and native <video> do not,
 * so a blocked stream is indistinguishable from a dead one by the time we reach
 * the error screen. One short GET recovers the status and the (tiny) error body.
 * Panels send `Access-Control-Allow-Origin: *` on these refusals, so the status
 * is readable; when a provider does not, the fetch rejects and we simply keep
 * the generic message.
 *
 * Resolves to { status, body } or null if nothing could be determined.
 */
async function probeProviderStatus(rawUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(rawUrl, { mode: "cors", signal: controller.signal });
    // A playing stream is an endless body — never read it, just drop the
    // connection. Only refusals (short HTML/text) are worth reading.
    if (res.ok) {
      controller.abort();
      return { status: res.status, body: "" };
    }
    const body = await res.text();
    return { status: res.status, body: body.slice(0, 200) };
  } catch (_) {
    // CORS-opaque, offline, or aborted — no verdict available.
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Last resort: everything failed (direct + Worker). Show the provider-outage
// message — no VLC/retry UI.
function showVlcFallback(rawUrl) {
  cleanupPlayers();
  // Capture before reportPlaybackFailure clears it: hls.js may already have
  // told us the upstream status, which saves a probe round-trip.
  const knownStatus = lastPlaybackError && lastPlaybackError.httpStatus;
  // Reported here rather than on each fatal HLS error: the escalation chain
  // above recovers most of them, so only reaching this point is a real,
  // user-visible failure. lastPlaybackError carries the underlying cause.
  reportPlaybackFailure(rawUrl);

  if (isGeoBlock(knownStatus)) {
    showGeoBlockError(rawUrl, knownStatus);
    return;
  }

  // Show the generic failure now rather than after the probe: the stream is
  // already dead either way, and a spinner that hangs on a slow provider is
  // worse than a message that sharpens a moment later.
  showError(PROVIDER_STREAM_ERROR);
  probeProviderStatus(rawUrl).then((probe) => {
    if (probe && isGeoBlock(probe.status, probe.body)) {
      showGeoBlockError(rawUrl, probe.status);
    }
  });
}

// Replace the generic provider error with the specific geo-block explanation.
function showGeoBlockError(rawUrl, status) {
  crumb("player", "geo-block detected", { status: status });
  reportGeoBlock(rawUrl, status);
  showError(T.geoBlocked, {
    title: T.geoTitle,
    icon: "🌍",
    detail: status ? T.providerCode + ": " + status : "",
  });
}

// Underlying cause of the current escalation chain, set by the HLS/mpegts
// handlers and consumed by showVlcFallback.
var lastPlaybackError = null;

/**
 * Add a breadcrumb if the reporter loaded. Kept as a one-liner so instrumenting
 * a code path costs nothing and can never throw into playback — error-reporter.js
 * is a separate script tag and may legitimately be absent.
 */
function crumb(type, message, data) {
  try {
    if (window.BeeErrorReporter && window.BeeErrorReporter.breadcrumb) {
      window.BeeErrorReporter.breadcrumb(type, message, data);
    }
  } catch (_) {
    /* never break playback */
  }
}

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

/**
 * Report a geo-block under its own error type. It reaches the dashboard as a
 * distinct row from a generic playback failure, so a provider that has started
 * refusing a whole country is visible as a pattern instead of noise.
 */
function reportGeoBlock(rawUrl, status) {
  try {
    if (!window.BeeErrorReporter) return;
    window.BeeErrorReporter.report({
      errorType: "GeoBlocked",
      message: "Provider refused this location (status " + (status || "unknown") + ")",
      upstreamUrl: rawUrl,
      contentName: title ? String(title).slice(0, 200) : undefined,
      contentType: rawUrl && rawUrl.indexOf("/live/") !== -1 ? "live" : undefined,
      context: { httpStatus: status },
    });
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
  // The stream URL carries provider credentials; never log it.
  console.log(`🎬 Starting playback: format=${format}`);

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

  // Retries and Worker escalation come back through here; register UI
  // listeners only once or Space/click toggle twice and cancel out.
  if (!controlsReady) {
    controlsReady = true;
    setupControls();
    setupKeyboard();
  }
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
      crumb("player", "HLS manifest parsed");
      hideLoading();
      video.play().catch(() => hideLoading());
    });

    hlsInstance.on(Hls.Events.ERROR, (_, data) => {
      // The payload carries request URLs (provider credentials); log the kind only.
      console.error("HLS error:", data.type, data.details, data.fatal);
      // Non-fatal errors are the interesting ones in the trail: a stream that
      // dies usually stutters through a dozen recoverable 404s first, and that
      // pattern is what tells you the provider is failing rather than the app.
      crumb("player", "HLS error " + (data.details || data.type), {
        fatal: !!data.fatal,
        status: data.response && data.response.code,
      });
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

  // mpegts.js logs loader errors with the full stream URL (credentials).
  mpegts.LoggingControl.enableAll = false;
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
    crumb("player", "MPEG-TS media info received");
    hideLoading();
  });

  mpegtsPlayer.on(mpegts.Events.ERROR, (type, detail) => {
    console.error("mpegts error:", type, detail);
    crumb("player", "mpegts error " + String(type || "") + " " + String(detail || ""));
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
  console.error("Video error:", video.error ? video.error.code : undefined);

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

/**
 * Show the error screen.
 *
 * `opts` lets a caller give the failure its own identity — title, icon and a
 * muted technical detail line (the provider's status code, which is the first
 * thing support asks for). Omitted parts fall back to the generic playback
 * error, so existing single-argument callers are unchanged.
 */
function showError(msg, opts) {
  const o = opts || {};
  loadingScreen.classList.add("hidden");
  playerContainer.classList.add("hidden");
  errorScreen.classList.remove("hidden");
  errorMessage.textContent = msg;

  const titleEl = document.getElementById("error-title");
  if (titleEl) titleEl.textContent = o.title || T.errorTitle;

  const iconEl = document.getElementById("error-icon");
  if (iconEl) iconEl.textContent = o.icon || "⚠️";

  const detailEl = document.getElementById("error-detail");
  if (detailEl) {
    detailEl.textContent = o.detail || "";
    detailEl.classList.toggle("hidden", !o.detail);
  }
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

  // Same ticket gate as the first load.
  playIfTicketValid();
}

function goBack() {
    if (isSafeReturnUrl(returnUrl)) {
        window.location.href = returnUrl;
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
