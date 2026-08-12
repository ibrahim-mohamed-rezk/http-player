/**
 * BeePlayer HTTP player — runtime error reporter.
 *
 * Dependency-free by design: this player is intentionally served over plain
 * HTTP (see nginx-player.conf) so it can reach HTTP-only IPTV providers that
 * the HTTPS app cannot. It is therefore the player people land on when streams
 * are already broken, which makes it the most valuable place to collect errors.
 *
 * Posting from an HTTP page to the HTTPS API is allowed by browsers (only the
 * reverse is blocked as mixed content). The API's CORS allowlist already
 * includes http://player.beeplayer1.com.
 *
 * Never throws, never blocks playback, never reports its own failures.
 */
(function () {
  "use strict";

  var INGEST_URL = "https://api.beeplayer1.com/error-reports/ingest";

  var FLUSH_INTERVAL_MS = 10000;
  var FLUSH_AT_COUNT = 10;
  var MAX_BATCH = 20; // must not exceed the backend DTO's ArrayMaxSize
  var DEDUPE_WINDOW_MS = 60000;
  var MAX_EVENTS_PER_SESSION = 50;

  var queue = [];
  var timer = null;
  var sessionCount = 0;
  var lastSeen = {};

  function token() {
    try {
      var params = new URLSearchParams(window.location.search);
      return params.get("token");
    } catch (e) {
      return null;
    }
  }

  function dedupeKey(input) {
    return (
      input.source +
      "|" +
      input.errorType +
      "|" +
      String(input.message || "")
        .toLowerCase()
        .replace(/\d+/g, "N")
        .slice(0, 200)
    );
  }

  function shouldDrop(input) {
    if (sessionCount >= MAX_EVENTS_PER_SESSION) return true;

    var key = dedupeKey(input);
    var now = Date.now();

    if (lastSeen[key] && now - lastSeen[key] < DEDUPE_WINDOW_MS) return true;
    lastSeen[key] = now;
    return false;
  }

  function flush(useBeacon) {
    try {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!queue.length) return;

      var events = queue.slice(0, MAX_BATCH);
      queue = queue.slice(MAX_BATCH);

      var body = JSON.stringify({ events: events });

      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(
          INGEST_URL,
          new Blob([body], { type: "application/json" })
        );
        return;
      }

      var headers = { "Content-Type": "application/json" };
      var t = token();
      if (t) headers["Authorization"] = "Bearer " + t;

      fetch(INGEST_URL, {
        method: "POST",
        headers: headers,
        body: body,
        keepalive: true,
      })["catch"](function () {
        /* silent — reporting a reporting failure would loop */
      });
    } catch (e) {
      /* never break playback */
    }
  }

  /**
   * Queue an error.
   * Field names must match the backend IngestErrorsDto exactly — it runs
   * forbidNonWhitelisted, so one stray key rejects the whole batch.
   */
  function report(input) {
    try {
      if (!input || (!input.message && !input.errorType)) return;

      input.source = input.source || "HTTP_PLAYER";
      if (shouldDrop(input)) return;
      sessionCount++;

      queue.push({
        source: "HTTP_PLAYER",
        errorType: String(input.errorType || "UnknownError").slice(0, 120),
        message: String(input.message || input.errorType).slice(0, 2000),
        level: input.level || "ERROR",
        stack: input.stack ? String(input.stack).slice(0, 20000) : undefined,
        httpStatus: input.httpStatus,
        upstreamUrl: input.upstreamUrl,
        contentType: input.contentType,
        contentName: input.contentName,
        url: window.location.href,
        context: input.context,
      });

      if (queue.length >= FLUSH_AT_COUNT) {
        flush(false);
      } else if (!timer) {
        timer = setTimeout(function () {
          flush(false);
        }, FLUSH_INTERVAL_MS);
      }
    } catch (e) {
      /* never break playback */
    }
  }

  window.addEventListener("error", function (event) {
    report({
      errorType: (event.error && event.error.name) || "WindowError",
      message: event.message || "Unknown window error",
      stack: event.error && event.error.stack,
      context: {
        file: event.filename,
        line: event.lineno,
        column: event.colno,
      },
    });
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason || {};
    report({
      errorType: reason.name || "UnhandledRejection",
      message: reason.message || String(event.reason),
      stack: reason.stack,
    });
  });

  window.addEventListener("pagehide", function () {
    flush(true);
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush(true);
  });

  window.BeeErrorReporter = { report: report, flush: flush };
})();
